# Plan implementacji refaktoryzacji modułu anten mikrofalowych

**Checkpoint T03, 2026-10-11 — przenośne ID i przekazanie do recenzji:**

`script_pipeline_compilation.rs::materialize_script_pipeline_with_output_policy_bounded`
generuje teraz `script-execution-<SHA>` zamiast `script-execution:<SHA>`.
Dwukropek jest odrzucany przez
`crates/fullmag-session/src/repository_path.rs::validate_store_id`.
Tekst autorskiego ID pozostaje w provenance i wejściu hasha, nie w ścieżce.
Dodano źródłową regresję
`execution_ids_are_portable_even_when_authored_ids_are_not_path_components`
z autorskim ID zawierającym Unicode, slash i dwukropek. Rustfmt check obu
plików exit 0; testu Rust nie kompilowano ani nie wykonano.

Read-only inspekcja wykazała osobną lukę kolejności: Study topological_order
nie jest barierą schedulera. Niezależne accepted kroki mogą być wybierane
równolegle, a raw antenna worker odrzuca input adapters. Nie dodano fikcyjnych
portów Artifact ani nie uznano kolejności snapshotów za gwarancję wykonania.
Jawny kontrakt zależności sterowania i rzeczywiste porty basis→LLG pozostają
do implementacji. T03 nie zamknięto.

Na żądanie użytkownika przygotowano checkpoint WIP wszystkich lokalnych
zmian do publikacji na branchu zadania, bez merge do mastera. Prompt dla
niezależnej recenzji znajduje się w
`docs/superpowers/plans/2026-10-11-microwave-antenna-pro-review-prompt.md`.
Publikacja nie certyfikuje builda, aktualnego runtime, UI ani nauki.

**Checkpoint T03, 2026-10-11 — kanoniczny wybór definicji/portu w snapshotach:**

Inspekcja obecnych konsumentów wykazała, że katalog przechowuje ProblemIR,
nie ResolvedScriptStageAction; preparation i accepted worker ponownie używają
zwykłego `fullmag_plan::plan`. Sam helper typowanej akcji nie wystarczał do
odtworzenia wyboru z wielodefinicyjnego pipeline.

`crates/fullmag-ir/src/study.rs::AntennaFieldSolveSelectionIR` dodaje
`stage_id: String` i `port_mode_id: String` w opcjonalnym
`StudyIR::AntennaFieldSolve.selection`. Są to bezwymiarowe identyfikatory
już zadeklarowanego modelu, nie nowa fizyka ani solver configuration.
Brak/null serializuje się bez selection i zachowuje historyczne reguły.
Obiekt wyboru odrzuca nieznane pola; `ProblemIR::validate` wymaga dokładnie
jednej pasującej definicji oraz zawartego w niej niepustego portu.
Nieprawidłowy jawny wybór nie przechodzi do fallbacku active_stage_id.

`crates/fullmag-application/src/script_stage_materialization.rs::standalone_antenna_study`
wiąże wybór z rzeczywistą akcją, osobno dla flat i pipeline.
`packages/fullmag-py/src/fullmag/runtime/run_config_export.py::_runtime_stage_action`
serializuje te same referencje w niemagnetycznym stage IR, przed eksportem
sprawdzając dokładnie jeden port. Wcześniejsze definicje nie są usuwane.
Publiczny builder anteny pozostaje źródłem wyboru; nie dodano kolejnego
parametru użytkownika ani wyboru zależnego od nazwy obiektu.

`crates/fullmag-plan/src/antenna_field_solve.rs::plan_standalone_antenna`
korzysta z kanonicznego wyboru, a `plan_antenna_external_lead_inspection`
odrzuca niezgodną akcję. `study_catalog.rs::capture_study_input_references`
hashuje całe IR, więc selection jest objęte dotychczasowym v3 fingerprintem
bez nowego schematu katalogu. Źródłowa regresja application wymaga zgodności
planu jawnej akcji ze zwykłym plannerem dla dwóch definicji i zmiany pinu
po zmianie wyłącznie selection. Rust IR/planner mają regresje optional wire,
odmów błędnych referencji i braku fallbacku; ich wykonanie pozostaje otwarte.

Interpretowane `test_antenna_standalone_authoring`: 10/10 PASS, pliki tmp
w istniejącym storage na D. Pierwsza próba w sandboxie dała cztery błędy
braku zapisywalnego tmp; powtórzenie z właściwymi uprawnieniami zakończyło
się exit 0. Rust parser/diff PASS nie oznacza kompilacji. Brak jeszcze
terminalnego buildu tego przyrostu, accepted runtime ani UI qualification.
Pełny compiler katalogu, stanowe porty i kwalifikowana baza nadal wymagane.
T03 pozostaje otwarte; checkpoint nie jest publikacją terminalnej noty naukowej.

Review wskazał konieczność pokrycia także ProblemIRV04 oraz odmowy starego
captured digest. Uzupełniono wspólny
`StudyIR::validate_antenna_selection`, wywoływany przez obie realizacje IR,
regresję `both_ir_versions_reject_a_missing_antenna_selection_reference`
oraz `study_catalog.rs::tests::captured_identity_rejects_a_selection_only_change`.
Ta ostatnia utrzymuje wszystkie inne bajty IR, w tym metadata i pełną
inwentaryzację, zmienia wyłącznie selection, wymaga innego SHA i odmowy
starej identity. W każdym snapshotcie regression application sprawdza
zachowanie obu definicji. Są to uzupełnienia źródłowe, bez wykonania Rust.

**Checkpoint T03, 2026-10-11 — wspólne planowanie dokładnej akcji inspekcji:**

`crates/fullmag-application/src/script_antenna_inspection_planning.rs::plan_script_antenna_inspection`
przejmuje istniejącą kontrolę z prywatnego CLI carrier. Ponownie rozwiązuje
model według jawnych `input.stage.id` i `input.port.id`, następnie porównuje
całe typowane wejście, requested execution i output. Różnica jest błędem;
metadata autora pozostaje nietknięte. CLI
`crates/fullmag-cli/src/orchestrator/antenna_external_lead_inspection/carrier.rs::plan_carrier`
deleguje do wspólnego właściciela zamiast utrzymywać drugą realizację kontroli.
Nie zmieniono równań, polityki fizycznej ani schematów publicznych.

Dodano źródłowe regresje w
`crates/fullmag-application/src/script_antenna_inspection_planning_tests.rs`:
`exact_action_plans_each_definition_without_rewriting_authored_activation`
materializuje dwie różne definicje w tym samym pipeline i planuje każdą
według jej akcji bez fallbacku do selektora autorskiego;
`stale_input_execution_and_output_are_rejected_independently` odrzuca
osobno zmienioną przewodność wejścia, precision i output. To testy napisane,
nie wykonane. Rustfmt parser/diff PASS i niezależny review źródłowy bez
wymaganych poprawek nie zastępują builda/runtime/nauki.

Odczyt kolejki potwierdził job `5414da4f92414d3b9281a0a18aee2bf3`
w stanie queued, exit null; jego kapsuła nie obejmuje tego przyrostu.
Pojedyncza sonda container-status odmówiła żądania koordynatora, ale ponowny
odczyt tego samego joba przez API zakończył się exit 0. Nie anulowano joba,
nie restartowano runnera ani workspace użytkownika. Nadal wymagane są
typowane lowering akcji do accepted catalog, porty stanów i pełna
kwalifikacja. Wspólny helper nie zamyka T03 ani nie promuje raw H do bazy.

**Checkpoint T03, 2026-10-11 — ID autora a definicja samodzielnego solve:**

`crates/fullmag-plan/src/antenna_field_solve.rs::plan_standalone_antenna`
wybiera jedyną definicję solve niezależnie od autorskiego `active_stage_id`.
Przy wielu definicjach zachowuje dokładny historyczny selektor ID i odmawia
przy braku dopasowania albo duplikatach; nie wybiera pierwszej definicji.
Nie zmienia metadata, nie dodaje publicznego pola IR ani nie kwalifikuje bazy.
Regresje w `crates/fullmag-plan/src/antenna_current_source.rs::tests`
porównują cały plan i sprawdzają zachowanie metadata oraz odmowy.
Review źródłowy selektora nie wskazał blokera; Rust pozostaje niewykonany.

`crates/fullmag-application/src/script_pipeline_compilation_tests.rs::standalone_antenna_pipeline_replans_without_conflating_authored_and_physical_ids`
dodaje integracyjną regresję źródłową: grupa zawiera dwa różne węzły autora
korzystające z jednej definicji solve. Test przechodzi przez rzeczywisty
materializer i ponowne `fullmag_plan::plan`; wymaga osobnych ID wykonania,
zachowanych przodków i autorskiej aktywacji oraz tego samego fizycznego planu.
Fixture `tests/fixtures/runtime/antenna-standalone-pipeline.json` pochodzi
z istniejącego przykładu Python z usuniętym wyłącznie magnetyzmem probe;
ścieżki i metadata źródłowe są znormalizowane, siatki i prądy pozostają dokładne.
`packages/fullmag-py/tests/test_antenna_standalone_authoring.py::AntennaStandaloneAuthoringTests.test_rust_pipeline_fixture_matches_actual_standalone_python_inputs`
wykonano: 1/1 PASS. To dowód pochodzenia wejść Python, nie wykonania Rust,
solvera, HTTP ani UI. Parser rustfmt i `git diff --check` PASS.
Aktualne testy Rust nie były kompilowane zgodnie z obowiązującym zakazem.
Wielodefinicyjny pipeline nadal wymaga jawnego typowanego selektora przy
lowering akcji do katalogu wykonania; ten checkpoint nie zamyka T03.

**Checkpoint T03, 2026-10-11 — rozdzielenie drzewa autora i ekspansji wykonania:**

Nowy `crates/fullmag-application/src/script_pipeline_compilation.rs::materialize_script_pipeline_with_output_policy_bounded`
zwraca ScriptPipelineCompilation: oryginalny typowany pipeline i jego
kanoniczny SHA, inventory wszystkich węzłów z inherited enablement oraz
listę rzeczywistych ResolvedScriptStage. Istniejący bounded materializer
wywoływany jest dokładnie raz. Dodatkowy traversal jedynie indeksuje
deklaracje, nie interpretuje payloadów, nie ekspanduje makr ani nie
produkuje własnego ProblemIR. Zachowuje także mutator po ostatnim
wykonaniu oraz wyłączone poddrzewa. Grupa i mutator nie otrzymują
fikcyjnego wykonania ani skopiowanego bazowego IR.

Wiązanie sprawdza authored ID, przodków, effective enablement i ciągłość
expansion_index. execution_id powstaje deterministycznie z kanonicznego
rekordu fullmag.script-execution-identity.v1 (authored_step_id i indeks);
kolizja wygenerowanych ID jest błędem. ID identyfikuje pozycję rozwinięcia,
nie bajty modelu ani globalny run. Przyszłe zasoby wymagają nadal scope
projekt/run i fingerprintu. active_stage_id zachowuje autorską semantykę
aktywacji drives; nie zastąpiono go ID wykonań. Wynik aplikacyjny nie
zmienia serde schematów StudyPlan/ProblemIR ani nie jest accepted catalog.

Dodano siedem regresji źródłowych: pełne drzewo/control→macro→control,
deterministyczne ID przy zmianie etykiety, kolizja/brak pipeline,
empty/all-disabled bez legacy solve, limit makra, primitive po makrze
z nowym prądem oraz odmowa mixed explicit/pipeline input.
Rustfmt --edition 2021 --check nowych plików i git diff --check PASS.
Niezależny review źródłowy nie wykrył blokera; uzupełniono wskazane
przypadki graniczne. Testów Rust nie kompilowano ani nie uruchamiano.
Brak jeszcze produkcyjnego konsumenta wyniku; kolejne kroki to typed
action lowering, content-owned katalog v3, jawne porty stanu oraz
kwalifikowana baza anteny/projekcja. Raw inspection nie jest tą bazą.
T03 pozostaje otwarte.

**Checkpoint T01/T14, 2026-10-11 — aktualny snapshot konsumentów w kolejce:**

Runner potwierdził health ok, accepting_jobs=true, worker_alive=true,
worker_error=null i działający job 57 (42a5ccb122a54981b2cc967fe5407eb7).
Zgłoszono job **67**, 5414da4f92414d3b9281a0a18aee2bf3,
request key antenna-cli-provenance-identity-20261011, profile fem-cpu-release.
Source capsule digest: 2ffb8aab5232182ac597a96b07c04f7a651d93bce682d71da498af66586fde2b.
Native snapshot SHA: da0e5dede7dc373da17318b338fc4cae2169094b552149e7512fb74b3df8be75.
HEAD: 41a5b8936b3eaa38420e9ba358cbf22ac7e2d803. Kapsuła obejmuje tracked WIP
i 37 jawnie sprawdzonych nowych plików, w tym CLI prepare/fingerprint,
provenance i globalną walidację ID. Edycje wstrzymano do zakończenia capture.
Stan zgłoszenia queued, bez dowodu kompilacji/runtime. Nowy moduł
script_pipeline_compilation i jego testy dodano później, więc job 67 ich
nie obejmuje. Nie uruchomiono drugiego runnera ani hostowego buildu,
nie przerwano cudzych zadań i nie zmieniono workspace użytkownika.

**Checkpoint T03/T08, 2026-10-11 — globalna tożsamość węzłów pipeline:**

W `crates/fullmag-authoring/src/validation.rs::validate_study_pipeline_nodes`
zbiór zajętych ID był tworzony osobno dla każdego poziomu drzewa. Pozwalało
to zaakceptować scenę z tym samym ID w różnych grupach lub z kolizją
grupa–dziecko, mimo że StudyPlan::validate wymaga unikalności globalnej.
Walidacja dokumentu przekazuje teraz jeden wspólny BTreeSet do wszystkich
potomków, także wyłączonych grup. Zachowano kontrole wersji, pustych ID,
etykiet i istniejące komunikaty błędów.

`crates/fullmag-application/src/script_stage_materialization.rs::materialize_study_pipeline`
wykonuje analogiczny preflight przez validate_pipeline_node_ids przed
ekspansją i mutacjami modelu. Direct script capture nie może więc ominąć
reguły sceny. ID nie są normalizowane ani automatycznie zmieniane; autor
musi rozstrzygnąć kolizję. Makro nadal może emitować wiele wykonań pod
jednym autorskim ID, rozróżnionych istniejącym expansion_index; nie są
to duplikaty dwóch deklaracji. Nie zmieniono StudyPlan ani formatu IR.

Dodano cztery regresje źródłowe authoringu oraz jedną parametryzowaną
regresję rzeczywistego materializera: rodzeństwo, różne grupy, grupa–dziecko,
wyłączony potomek i pusty ID. Poprawne zagnieżdżone drzewa pozostają objęte
testami. Parser rustfmt --edition 2021 --emit stdout obu plików i
git diff --check PASS; review źródłowe obu zmian bez wykrytego blokera.
Nie kompilowano ani nie uruchamiano testów Rust. Bieżący odczyt joba 63:
5d8062970f8a4aaca25881e5e84e9780, queued, exit_code=null. Żaden dotychczasowy
snapshot nie obejmuje tej późniejszej poprawki. T03/T08 pozostają otwarte;
zmiana usuwa niejednoznaczność ID, nie wdraża jeszcze pełnego kompilatora
authoring→execution ani przepływu stanów i baz pola między etapami.

**Checkpoint T03/T14, 2026-10-11 — fingerprint Submit i odczytu CLI:**

`crates/fullmag-cli/src/accepted_run_transport.rs::submit_run_json` parsuje
teraz kanoniczny RunIntent, wykonuje jego validate i oblicza
RunIntent::payload_fingerprint przed żądaniem HTTP. Wspólny
validate_run_receipt wymaga dokładnego run_id i payload_fingerprint zarówno
w odpowiedzi Submit, jak i późniejszym GET runu. Niezgodny Submit przerywa
ścieżkę przed POST materialization; GET nadal sprawdza także project_id.
Fingerprint pochodzi z istniejącego RunSpecification::fingerprint, nie
z nowego algorytmu ani z hasha surowego JSON. Nie zmieniono schematu API.

Dodano źródłową regresję zgodnego receiptu oraz zmiany, braku, null i
niewłaściwego typu obu kontrolowanych pól. Rustfmt --edition 2021 --check
transportu oraz git diff --check PASS. Niezależny review źródłowy nie
wskazał błędu poprawności. Testów Rust nie kompilowano ani nie uruchamiano;
test helpera i odczyt kolejności wywołań nie zastępują regresji HTTP,
która potwierdzi brak materializacji po błędnej odpowiedzi serwera.

Bieżący odczyt runnera: job 66, 3534b67c3e9a4f0d890860c00590d605,
pozostaje queued, exit_code=null. Jego kapsuła powstała przed zmianami CLI,
więc nie będzie dowodem ich kompilacji. T03/T14 pozostają otwarte;
kolejny pełny snapshot konsumentów oraz rzeczywisty test prepare→Submit
muszą objąć aktualny kod. Nie zmieniono działającego workspace użytkownika.

**Checkpoint T01/T14, 2026-10-11 — zweryfikowany pełny pakiet joba 56:**

Odczytowy `_validate_managed_build` z istniejącego export_runner_openapi
zweryfikował queue/context/coordinator receipt, trusted inputs, source capsule
i build receipt wraz z hashami **127 artefaktów** dla joba
`4dc9fed201aa4a04a97b155999394321`: succeeded, exit 0.
Przypięte źródła: HEAD `41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`,
source digest `a6c9bf8cc42446a36667d4a1d1f9df9403adfb85c5fe83053964edeb409026df`,
native snapshot `e6da8f8672298d3467fee8943902f50d3452f026dc48fd9dab71bdf524ab0e15`.
Build receipt SHA `acacb4af4b2430690cc3b5b38fe8b2cb512c7717e4d8dbe9c9ef3a234be2ad9c`,
API binary SHA `168b181774b0d0201baa107a790da4559989d0ee50705c9027f2f3c952ca779f`,
source manifest SHA `987639c57cafabbd6c31881c3c704470d784b29807b67990e9e87a7ba10d096b`.

Nie uruchomiono tego API ani solvera, nie eksportowano starego OpenAPI i nie
generowano z niego klienta aktualnego kontraktu. Receipt zachowuje
qualification=NOT VERIFIED. Job 56 nie dowodzi zmian producer/prepare API/CLI
ani typowanego provenance dodanych po jego capture. Bezpośrednie bieżące
odczyty jobów 63, 65 i 66: queued, exit_code=null. Weryfikacja pakietu usuwa
niepewność integralności joba 56, nie zamyka T01/T14 ani bramek naukowych.

**Checkpoint T03, 2026-10-11 — rzeczywiste powiązanie autorskiego węzła z ekspansją:**

Rozpoznanie kodu potwierdziło, że scene_document_to_study_plan zachowuje
grupy/controls/makra, a materialize_script_stages_with_output_policy_bounded
emituje wyłącznie rzeczywiste wykonania. Mutacje modelu mogą emitować None;
macro ma kilka wyników z tym samym active_stage_id. materialize_study_execution
wymaga natomiast wejść dla każdego enabled StudyStep. Zatem nie wolno zipować
tych list ani przypisać jednego bazowego IR wszystkim węzłom. Pipeline ekspanduje
Rust, nie drugi niezależny walker Python. Istniejące scene capture helpers
w script.rs nie mają jeszcze produkcyjnego konsumenta poza własnym wrapperem.

Dodano ScriptStageProvenance i opcjonalne ResolvedScriptStage.provenance.
Ten sam walk_study_pipeline_nodes zapisuje authored_step_id, zerowy lub
deterministyczny macro expansion_index, ścieżkę ancestor_group_ids oraz
label/notes/source. Disabled grupy nadal pomijają całe poddrzewo; grupa nie
tworzy zadania native, a controls nie są zamieniane w fikcyjny solve. Nie
zmieniono ProblemIR, active_stage_id, kolejności etapów, polityki output ani
budżetu ekspansji. Nowe dane są oddzielnym typowanym powiązaniem aplikacyjnym,
nie nowym modelem fizyki i nie publicznym schematem IR.

Źródłowo dodano regresję macro relax→run (dwa indeksy, jedno autorskie ID,
notes/source), rozszerzono nested-group i disabled-group regressions.
Review źródłowe nie wskazało blokera; na jego sugestię dodano osobną
regresję powrotu z inner/outer do rodzeństwa (odpowiednio [outer] i []).
Parser rustfmt obu plików oraz git diff --check PASS. Testów Rust nie
kompilowano/uruchamiano. Explicit flat stages nadal korzystają z istniejącego
active_stage_id w swoim IR; ich provenance konstruktorów pozostaje None.
Wymagany kolejny fragment: typowany kompilator zachowujący drzewo authoring
i jawnie mapujący je na rzeczywiste wykonania, porty/stany oraz katalog v3
przez materialize_captured_study_input, bez ponownego bindu profilu.
Mutacje modelu i zależności stanów wymagają własnych dowodów; nowy opis źródła
sam ich nie kwalifikuje. T03 pozostaje otwarte, zmiana po capture joba 66.

**Checkpoint T03/T14, 2026-10-11 — jawny konsument CLI prepare→Submit, źródłowo:**

Dodano Command::PrepareRunJson i
`crates/fullmag-cli/src/accepted_run_transport.rs::prepare_run_json`.
Przyjmuje dokładny ProjectRunIntentRequest oraz jawne project_id/API origin,
wywołuje nowy endpoint, sprawdza RunIntent.validate, wszystkie pola
RunIntentAuthoring, project/revision oraz lokalnie wyliczony fingerprint.
`prepared_submission` zwraca dokładnie pięć pól dotychczasowego Submit,
zachowując wejściowe archive/Study/catalog/asset_paths. Stdout jest JSON
dla osobnego run-json; brak automatycznego Submit, store, solve i zapisu pliku.
Nie jest to jeszcze scene/script→Study/ProblemIR compiler ani integracja UI.

Dodano trzy regresje Rust źródłowo: parser osobnej komendy, zachowanie
Submit shape/exact inputs i odmowy dla zmienionych IDs/revision/key/fingerprint
oraz priority. Nie kompilowano/uruchamiano testów. Rustfmt check transportu,
parser main/args i git diff --check PASS. Review wskazało nieograniczony
Response::text; poprawiono wspólny odczyt response_json na Read::take:
success maksymalnie 96 MiB + sentinel, błąd maksymalnie 2 KiB przed alokacją.
Usunięto sprzeczny komentarz komendy. Nie jest to runtime proof.
Zmiana CLI powstała po capture joba 66 i nie jest objęta jego snapshotem.
Następny finalny build konsumentów oraz rzeczywisty prepare→Submit test,
kanoniczny compiler, generated client i UI pozostają do wykonania.

**Checkpoint T03/T14, 2026-10-11 — pełny snapshot producenta i API w kolejce:**

Po zakończeniu capture zgłoszono jeden managed build FEM CPU release:
job **66**, `3534b67c3e9a4f0d890860c00590d605`, request key
`antenna-run-intent-api-20261011`, source capsule digest
`18b900283c8307b678fc618c90c4a68213f8ce36273a21c1c9aad752e38ac489`.
Native source snapshot SHA:
`1b59d3a84102fa81a340a952a85fc4e4cb20bf414e2b16e57df6d0a62781ce3f`,
HEAD `41a5b8936b3eaa38420e9ba358cbf22ac7e2d803` z uwzględnionym dirty WIP.
Snapshot obejmuje tracked WIP i 37 jawnie wskazanych nowych plików, w tym
RunIntent producer, API handler, nowe schematy/router/OpenAPI, neutralny
pakiet anteny oraz narzędzia HTTP/worker. Edycje wstrzymano na czas capture.
To build release, nie zadanie kompilacji testów jednostkowych; obecność źródeł
testów w snapshotcie nie oznacza ich wykonania. Nie anulowano starszych jobów.

Przed zgłoszeniem health runnera: ok/accepting_jobs/worker_alive=true,
worker_error=null, aktywny job 57 running. Job 56 przy bezpośrednim odczycie
jest succeeded/exit 0; nie przypisano jego sukcesu nowemu producerowi ani API,
nie zweryfikowano w tym checkpointcie jego receipt i kompletu artefaktów.
Job 66 pozostaje queued, nie dowodzi kompilacji, runtime, API generation,
frontend integration ani fizyki. Następna bramka wymaga terminalnego sukcesu,
weryfikacji receipt/hashów, wygenerowanego klienta oraz prepare→Submit runu
z tym samym fingerprintem. Cały cel T00–T18 pozostaje otwarty.

**Checkpoint T03/T14, 2026-10-11 — konsument producenta w API, źródłowo:**

Dodano `router_v2/handlers/persistence/run_intent_preparation.rs::prepare`
oraz POST `/v2/persistence/projects/{project_id}/run-intent`, schematy
ProjectRunIntentRequest/Resource i rejestrację router/OpenAPI. Handler otwiera
dokładne bounded archive bytes przez FileProjectRepository, odrzuca read-only,
sprawdza archived ProjectId/revision, parsuje RunIntentAuthoring/Study/katalog,
wywołuje wspólny producent oraz snapshot-only validate_requested_execution.
Nie otwiera store/sesji, nie publikuje CAS, nie przyjmuje runu ani nie wykonuje
solvera. Published profiles/admission pozostają odpowiednio granicą Submit
i późniejszego runtime. expected_revision nie oznacza porównania z latest scene.

Zapisano cztery regresje Rust: deterministyczne ponowienie z jawnym RunID/key,
konflikt ID/revision, błędne archiwum/brak assetu oraz unknown authoring/conflict
execution. Nie kompilowano ani nie uruchamiano ich zgodnie z zakazem repo.
Rustfmt z właściwą edition=2021 i git diff --check PASS; review źródłowe bez
wskazanego blokera, nie kwalifikacja runtime. Wcześniejszy test producenta
uzupełniono o niepuste parameters/seeds/dependencies i priority=7. Brakuje
regresji katalogu v3 z execution_materialization, read-only HTTP oraz realnego
prepare→Submit z identycznym fingerprintem. Nie edytowano generated client.

Job 65 przy aktualnym odczycie nadal queued, bez exit code; jego snapshot nie
obejmuje producenta ani tego handlera. Pełny build nowych źródeł, zweryfikowana
generacja OpenAPI/client, scene/script compiler i UI flow pozostają otwarte.
Nie zamknięto checkboxów T03/T14 i nie zmieniono localhost:3197.

**Checkpoint T03/T14, 2026-10-11 — wspólny producent RunIntent, źródłowo:**

Dodano `crates/fullmag-application/src/run_intent_materialization.rs::materialize_run_intent`
oraz jawne wejście `RunIntentAuthoring`. Producent przyjmuje już skompilowany
StudyPlan/katalog i ProjectEnvelope, zachowuje RunID/idempotency, parametry,
seeds, dependencies, scheduling priority oraz requested execution. Używa
istniejących ProjectSnapshot, StudyReference, RunSpecification i RunIntent;
hash katalogu wyznacza przez `fullmag_ir::canonical_ir_json_sha256`, a referencje
assetów przez rzeczywiste bytes OpaqueAsset i jawne wiązania ID→path. Nie czyta
hosta, nie publikuje CAS, nie otwiera sesji i nie wykonuje solvera. Sprawdza
Study/katalog, materializację profili, lowering i per-problem konflikt requestu.
Pełna kontrola execution plan oraz published profiles nadal należy do
dotychczasowej granicy Submit; wynik producenta nie oznacza admission/readiness.

Cztery regresje Rust zapisano źródłowo: stabilny replay, exact raw definition
bytes, asset bytes/missing path oraz konflikt requestu/niespójny envelope.
**Nie kompilowano ani nie uruchamiano tych testów** zgodnie z ograniczeniem
AGENTS.md. Parser/formatowanie dwóch nowych plików przez rustfmt oraz
`git diff --check` PASS; to nie jest dowód kompilacji ani runtime.
Brakuje jeszcze wywołania producenta w produkcyjnej granicy API/CLI,
kanonicznego scene/script→Study/per-step IR, regeneracji klienta oraz UI Submit.
Nie dodano alternatywnego formatu fizyki ani ręcznie generowanego OpenAPI.
Job 65 nadal queued i jego wcześniejszy snapshot nie zawiera tego producenta;
potrzebuje on późniejszego pełnego managed buildu wraz z konsumentem API.

**Checkpoint T12/T14, 2026-10-11 — kontynuacja rzeczywistego accepted workera:**

Dodano `scripts/accepted_antenna_runtime.py::execute`, wywoływalną kontynuację
od już przyjętego i przygotowanego pojedynczego zadania antenowego. Korzysta
z produkcyjnego resource publishera, schedulera i workera, bez kompilacji;
odczytuje zwolniony lease, journal i terminalne receipts, następnie wykonuje
istniejącą bramkę HTTP V/J/H. `validate_worker_publication` wiąże opublikowany
pakiet z run/task/attempt/epoch/case, CPU budgetem i dokładną komendą Start.
Wymaga jednego `inspection/Artifact`, nie fikcyjnego stanu magnetyzacji.
Obserwacyjny timeout zachowuje proces zgodnie z istniejącym `run_process`.
Pięć interpretowanych regresji powiązań PASS; `git diff --check` PASS.
Źródłowy review nie wskazał blokera; fixture lease poprawiono do rzeczywistego
pięciopolowego ResourceLease, odrębnego od trwałego lease receipt.
Kontrola plan_fingerprint sprawdza format i tożsamość started/completed,
nie zastępuje porównania z oczekiwanym planem przygotowania ani jego kwalifikacji.
Nie wykonano jeszcze tej kontynuacji na realnym pakiecie ani nie podłączono
jej do kompletnego managed RAM drivera: to nie jest kwalifikacja runtime.
Wywołujący musi poświadczyć pakiet/obraz, izolację całego Submit store w tmpfs,
kanoniczne wejścia oraz osobny manifest narzędzi hostowych.

Rozpoznanie producentów potwierdziło, że
`router_v2/handlers/platform/compute_preview.rs::build_preview` materializuje
kanoniczny katalog i jego hash. CLI `accepted_run_transport.rs::submit_run_json`
tylko przesyła gotowy request. Nie znaleziono produkcyjnego producenta całego
RunIntent ze sceny/skryptu; znalezione konstruktory RunSpecification/RunIntent
pozostają w testach. Następna integracja T03/T14/T15 wymaga wspólnego producenta
prepared submission, z dokładnymi bytes projektu, StudyPlan, per-step ProblemIR,
profilem i kompletnym zestawem immutable assets. Nie zastępować go ręcznie
zmodyfikowanym fixture magnetycznego runu. Job 65 nadal queued; runner zdrowy,
job 56 running. Nie przerywano buildu ani workspace użytkownika.

**Checkpoint T14, 2026-10-11 — niezależne porównanie retained V/J/H:**

`scripts/smoke_accepted_antenna_inspection.py::verify_retained_payloads`
sprawdza teraz projekcje bajt po bajcie względem zachowanego bundle i ordered
current snapshot: ID/współrzędne/potencjał węzłów, kolejność Tet4, środki
i cell-local vertex samples J, pozycje próbkowania i H. Sprawdza hashe
wewnętrznych rekordów oraz powiązanie H z charge/current source. Nie odtwarza
J interpolacją ani nie skaluje przez prąd. Łączny budżet retained porównania
to 2 MiB; większa scena nie jest kwalifikowana tym małym narzędziem.
To porównanie wybranej projekcji/framing, nie pełny native canonical decoder
ani niezależna walidacja solvera. Capabilities FFT/per-ampere/LLG pozostają false.

Pięć interpretowanych regresji PASS. Nowa regresja akceptuje syntetyczny
retained fixture i odrzuca zmienione V, XYZ, Tet4, ID, sampling positions, H
oraz cztery projekcje J mimo możliwości ponownego podpisania deskryptorów.
Mock transportu jawnie nie kwalifikuje framing; odrębna regresja go sprawdza.

Nowy verifier wykonano również offline na zachowanym archiwum wcześniejszego
managed RAM runu `d13d6b1cc2cc41e193bbd5135fcbdf57`: PASS,
16 device nodes, 12 cells, 4 H samples, 12 payloadów. Archiwum
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/managed-antenna-http-ram-cpu/runs/d13d6b1cc2cc41e193bbd5135fcbdf57/export/antenna-cold.fms`
ma SHA-256 `43df8b864dee25beaf38edb097f5d4c904a6cf074dd6320cc3a1aab51b474a19`.
Podstawowe payloady odczytano bezpośrednio z bounded ZIP; odtworzone projekcje
geometrii/J porównano z hashami zachowanych cold API display descriptors.
Nie było nowego solve ani nowego HTTP. Wynik nie kwalifikuje accepted Study
API, aktualnego UI, durable store ani LLG/FFT. Job 65 przy odczycie nadal queued;
nowy skrypt jest narzędziem hostowym, a jego tożsamość przyszły runtime gate
musi przypiąć osobnym tools manifest, nie przypisać do starszego solver snapshotu.

**Checkpoint T12/T14, 2026-10-11 — recovery i bramka HTTP accepted wyników:**

Read-only review wskazał dwa konkretne problemy źródłowe.
`accepted_study_worker.rs::execute_accepted_antenna_worker_start` finalizuje teraz
eksport projektu przez `AcceptedProjectStorage::finish` przed zapisaniem completed
receipt, jak sąsiednie ścieżki FDM/FEM. Zewnętrzna finalizacja failure/cancellation
pozostaje; powtórne `finish` po sukcesie jest istniejącym idempotentnym no-op.
Nie przeprowadzono jeszcze testu przerwania procesu między tymi operacjami.

`recover_completed_worker_execution` sprawdza zadeklarowany łączny budżet
unikalnych obiektów przed ich alokacją, odrzuca sprzeczne długości dla jednego
CAS ref oraz stosuje istniejący limit kodeka pakietu anteny.
`read_recovered_worker_object` sprawdza pełny hash/długość strumieniowo i używa
ograniczonego `get_verified_range`, zamiast `CAS.get`. Obejmuje również
observation snapshot/state w wspólnej ścieżce recovery. Pusty obiekt pozostaje
pustym buforem przekazywanym do dotychczasowej walidacji kodeka.
Nie jest to globalny limit RSS, nie kwalifikuje też równoległych requestów.

Dodano `scripts/smoke_accepted_antenna_inspection.py::verify`: odczytowy test
wymaga jawnych project/run/Study step, wybiera dokładnie jedną publikację
i sprawdza wspólny display V/J/H, SI, geometrię/liczności, 12 payloadów,
SHA, ETag zależny od durable owner, 304/206/416 oraz 6 odmów 409 dla starych
attempt/epoch/package mimo If-None-Match/Range. Nie przypisuje Live session
i nie promuje raw inspection do per-ampere, FFT ani LLG. Nie tworzy wyników
solverowych ani nie mutuje sceny. Cztery interpretowane regresje narzędzia
w `test_smoke_accepted_antenna_inspection.py` PASS, w tym mock pełnego HTTP.
Mock nie jest dowodem wykonania backendu, poprawności RT0 ani fizyki.

Rust syntax parse przez rustfmt stdout PASS (bez zmiany pliku i bez kompilacji);
interpretowane kontrole kolejności/budżetów PASS; diff check PASS.
Kompilacja nowych zmian, real accepted HTTP i crash recovery: **NOT VERIFIED**.
Job 56 potwierdzono jako running, job 63 jako queued; koordynator zdrowy.
Lista całej kolejki zwróciła HTTP 500, lecz odczyt konkretnego joba działał;
nie restartowano runnera ani workspace. Snapshot 63 nie obejmuje tych poprawek.

Ponowny read-only review poprawek nie wykazał konkretnej regresji. Otwarte:
nieograniczony odczyt JSON attempt receipt, kopie payloadów przy dekodowaniu
i wielokrotne materializacje tego samego CAS ref; budżet storage nie jest RSS.
Awaria po eksporcie, ale przed completed receipt pozostawia próbę unknown
i recovery odmawia ponownego solve — brak fault-injection dowodu.
Zlecono normalny build aktualnych źródeł (bez kompilacji unit testów):
seq 65, job `51d0e494bcd948be97288981a6868310`, stan po submit `queued`,
source digest `0263a84769dd15f980d370a774b392c4e0b1c99964b5362a1375662809452884`.
Capture zawierał 31 jawnie wskazanych nieśledzonych wejść; edycje były
wstrzymane do zakończenia capture. To zgłoszenie, nie dowód kompilacji.

**Checkpoint T12/T14, 2026-10-11 — weryfikacja pakietu 55 i strumieniowanie assetów:**

`fullmag-runtime-control/src/study.rs::load_accepted_study_snapshot` sprawdza
teraz przypięte immutable assets przez
`fullmag-session/src/cas.rs::CasStore::verified_length`, zamiast alokować
pełny bufor przez `get` i następnie go odrzucać. Sprawdzenie całej zawartości
SHA-256, powiązania z RunSpec i błędu brakującego obiektu pozostaje zachowane.
Istniejący `stream_file_identity` używa bufora 64 KiB i sprawdza również
niezmienność długości. Nie jest to globalny limit RSS endpointu: JSON study
i catalog nadal są materializowane, podobnie jak wybrany pakiet pól.

Dodano regresje Rust dla uszkodzenia obiektu bez zmiany długości oraz pustego,
brakującego i nieprawidłowego object ref. Testów jednostkowych nie kompilowano
ani nie uruchamiano zgodnie z ograniczeniem repozytorium. Interpretowana
kontrola źródeł zachowania integralności i braku pełnej alokacji assetu PASS;
`git diff --check` PASS. Scoped rustfmt wykazał wcześniejsze różnice formatowania
w niezmienionych fragmentach CAS; nie wykonano pobocznego formatowania.
Kompilacja i pomiar pamięci tej poprawki pozostają **NOT VERIFIED**;
snapshot 63 jej nie obejmuje.

Job 55 `713429ba647141248db59382c09522a7` potwierdzono terminalnie
`succeeded`, exit 0. `scripts/export_runner_openapi.py::_validate_managed_build`
zweryfikował receipt, kapsułę źródeł i 127 artefaktów; dodatkowe
`ManagedBuild::input_hash_mismatches` zwróciło pustą listę.
Source digest: `6c508b09ca0f55a54c6b75d4f3c2fb605dfdda45fa35fb0814badc8ed7013313`;
native snapshot: `703524bf128d209d2994b35568a6d0fcee03edaf820e4c618882b5a658f16c23`;
receipt SHA-256: `f293b1787bc5e43cfc60ced30ec08ccc9e6a6302dc77d5c59bc54036a30ecf23`.
Pakiet: `storage/runs/microwave-antenna-latest-2026090-78aaec16ccf52671/713429ba647141248db59382c09522a7/artifacts/outputs/.fullmag/local`.
Jest to dowód starszego buildu, nie najnowszego accepted API ani kwalifikacji
fizyki/UI. Joby 61, 62 i 63 przy ponownym odczycie nadal `queued`.
Nie uruchomiono ani nie restartowano workspace użytkownika.

**Checkpoint T14/T15, 2026-10-11 — katalog accepted wyników i wspólny opis V/J/H:**

Dodano zasoby `accepted_antenna_resource.rs::get_accepted_antenna_catalog`
oraz `get_accepted_antenna_inspection`. Collection
`GET /v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections`
zwraca aktualne published owner identities, w tym Study/native stage, task,
attempt/epoch oraz manifest/package/artifact/case. Nie dekoduje pakietów pól
i deklaruje tylko `validation_scope=published_output_manifest`, bez display
capabilities. To konieczne, ponieważ dotychczasowy zasób runu nie udostępnia
frontendowi pinu pakietu anteny; klient nie powinien go zgadywać.

Pojedynczy zasób pod `/antenna-inspections/{step_id}` wymaga pinu
attempt/epoch/package i po pełnej walidacji pakietu oraz accepted plan zwraca
manifest, jawne port/output ID oraz wspólny display contract. Manifest tego
zasobu deklaruje `validation_scope=accepted_plan_and_payloads`. JSON zawiera
deskryptory, liczności i provenance, nie tablice V/J/H ani topologię liczbową.
Numeryczne dane pozostają w endpointach binarnych. Accepted identity nie
zawiera fikcyjnego session scope, revision Live ani rekordu CLI.

`antenna_inspection.rs::inspection_display_data` jest wspólną projekcją dla
Live i accepted: V na obliczonej geometrii urządzenia, cell-local J z RT0,
H w domenie próbkowania, jednostki i SHA tych samych payloadów. Publiczny
kształt dotychczasowego `AntennaInspectionDisplayResource` pozostaje bez zmian.
Kontrola liczności J/topologii, opcjonalnego legacy J oraz v1/v2 pozostaje.
Capabilities per-ampere/source-FFT/LLG pozostają false; walidacja bytes/plan
nie jest kwalifikacją fizycznej bazy wymuszenia.

Provider współdzieli kontrole accepted publication przez
`with_accepted_antenna_publications`: discovery odwiedza tylko metadata,
a pinned reader sprawdza query identity przed odczytem pakietu wybranego
etapu. Fence katalogów wykonuje się po visitorze, również po dekodowaniu pól.
Ograniczenia peak RSS snapshotu i brak kwalifikacji równoległych requestów
z poprzedniego checkpointu pozostają otwarte; discovery nie usuwa tego limitu.

Weryfikacja: interpretowane kontrole kontraktu źródeł PASS, w tym porównanie
pól Live schema z HEAD i ich mapowania do wspólnej projekcji; scoped rustfmt
trzech accepted plików PASS, global diff check PASS. Dwa read-only review
(projekcja/metadata oraz faktoryzacja discovery/pinned reads) nie wykazały
konkretnego defektu. Dodano nieuruchomione regresje OpenAPI required pins,
braku fikcyjnego Live scope oraz walidacji query. Unit testów nie kompilowano.
Kompilacja, wygenerowane OpenAPI i HTTP tego fragmentu: **NOT VERIFIED**.
Seq 55 potwierdzono `running`, seq 62 `queued`; snapshot 62 nie obejmuje
tego nowego metadata/discovery fragmentu. Zlecono własny normalny build
`fem-cpu-release`: seq 63, job `5d8062970f8a4aaca25881e5e84e9780`,
stan po submit `queued`, source digest
`fa43863e3ac435f89bf3563f61e01ce16c7e2653c54007e0d31942d123f85412`;
29 jawnie wskazanych nieśledzonych plików anteny. Nie jest to dowód kompilacji.
Końcówka logu starszego seq 55 pokazała native-build i frontend-build exit 0,
lecz odczytany stan kolejki pozostawał `running`; nie promowano pakietu do
terminalnego succeeded ani nie restartowano koordynatora.
Generated client/facade/hooks oraz podłączenie wyboru do wspólnego Inspectora
i browser V/J/H pozostają kolejnymi krokami. Workspace użytkownika bez zmian.

**Checkpoint T14/T15, 2026-10-11 — trwały endpoint binarny accepted inspection:**

Provider `accepted_antenna_inspection.rs::load_accepted_antenna_inspection`
odczytuje teraz jeden jawnie wskazany Study step, zamiast dekodować pakiety
wszystkich anten w runie. Przed odczytem pakietu sprawdza wymagane
`attempt_id`, `ownership_epoch` i `package_object_ref`. Zachowuje kontrolę
published membership, manifestu, pełnego package→plan binding oraz ponowny
odczyt katalogów. Osobna kontrola RunSpec zwraca konflikt dla projektu innego
niż właściciel runu. Po walidacji neutralnego kodeka jego payloady są zwalniane
przed walidacją runnera; zachowywany jest tylko reference, a następnie loaded
result. Nie oznacza to pojedynczego dekodowania ani globalnego limitu RSS.

Dodano `accepted_antenna_payload.rs::get_accepted_antenna_payload`, route
`GET /v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections/{step_id}/payloads/{payload_kind}`
i rejestrację w `openapi_v2.rs`. Jest to trwały zasób projektu/runu, nie
adapter bieżącej sesji i nie udawany rekord CLI. `step_id` oznacza ID Study;
native stage ID pozostaje oddzielną częścią owner identity. Query wymaga
trzech pinów publikacji powyżej. Nieznany payload kind jest odrzucany przed
odczytem storage. Endpoint współdzieli `antenna_inspection.rs::select_payload`
oraz `validate_payload_kind`, więc V/J/H, geometria i ich długości/SHA mają
tę samą projekcję co istniejąca ścieżka Live. ETag obejmuje projekt, run,
Study/native stage, task, attempt, epoch, manifest/package/artifact, kind
i SHA payloadu. Conditional response i Range następują dopiero po pełnej
walidacji. Nie dodano nowych ilości fizycznych, bazy na amper ani LLG/FFT.

Review źródłowy wskazał otwartą bramkę pamięci: istniejący
`fullmag_runtime_control::load_accepted_study_snapshot` materializuje dodatkowo
Study, catalog i immutable assets przez CAS `get`. Limit wejścia FMANTPK1
nie ogranicza całego peak RSS ani równoległych requestów. Potrzebna pozostaje
kwalifikacja limitów i reader metadata/streaming verification bez pomijania
hashy zasobów. Ponowna kontrola całych katalogów jest konserwatywna: zmiana
niepowiązanego tasku może dać 409; nie należy usuwać fence bez zastępczej
kontroli dokładnego ownera i published entries.

Weryfikacja tego fragmentu: interpretowane kontrole kontraktu źródeł PASS,
scoped `rustfmt --check` dwóch nowych plików PASS, `git diff --check` PASS.
Regresja pinów jest zapisana w Rust, lecz unit testów nie kompilowano ani
nie uruchamiano. Kompilacja i HTTP nowego endpointu pozostają **NOT VERIFIED**.
Zlecono normalny kontenerowy build `fem-cpu-release`: seq 62,
job `6af20983967842d18a9cd89e674220a2`, stan po submit `queued`,
source digest `e80f38d577e6f066e5c4fa62a1372ebfcb4d18c83ced96f7d8326c4aa2bd884a`.
Snapshot zawiera 28 jawnie wskazanych nieśledzonych plików anteny; receipt
submit nie jest dowodem udanej kompilacji. Starszy seq 61 nadal queued przy
ostatnim odczycie. Koordynator potwierdził `ok`, `accepting_jobs` i `worker_alive`;
sprawdzenie wymagało dostępu poza sandboxem, bez restartu koordynatora.
Generated frontend client nie został ręcznie zmieniony; regeneracja wymaga
zarządzanego eksportu OpenAPI aktualnego buildu. Metadata/display resources,
facade/hooks, wybór accepted wyniku i browser V/J/H pozostają do podłączenia.
Nie zmieniano modelu ani nie restartowano workspace 3197. Poniższe wcześniejsze
checkpointy opisują stan historyczny, nie aktualną sygnaturę providera.

**Checkpoint T14/T15, 2026-10-11 — ścisły accepted CAS reader i wybór wykonania UI:**

Zaimplementowano i zarejestrowano wewnętrzny provider
`crates/fullmag-api/src/router_v2/handlers/data/accepted_antenna_inspection.rs`
(`load_accepted_antenna_inspections`). Caller musi podać zaufane ProjectId/RunId
i ogrodzić kontekst bieżącej sesji; helper nie definiuje nowego endpointu.
Odczyt wiąże immutable accepted Study i execution plan, aktualny succeeded
task/attempt/ownership epoch, Published membership w katalogu, pojedynczy
manifest bez duplicate JSON keys, exact inspection/artifact/codec tuple,
registered artifact/case/CAS SHA i pełny package→plan binding. Magnetic
state/observation refs są odrzucane. Oba katalogi są sprawdzane ponownie po
odczycie. Manifest ma oddzielny limit 1 MiB; verified CAS reads są ograniczone,
a suma zachowanych pakietów runu nie może przekroczyć maksymalnego budżetu
jednego FMANTPK1. Nie ma filesystem discovery ani promocji do bazy na amper.
API otrzymało jawną zależność od neutralnego crate'a; Cargo.lock jest zgodny
z tą nową lokalną zależnością. Provider nie jest jeszcze wywoływany przez HTTP.

Naprawiono frontendową ścieżkę legacy/current-live:
`AntennaVisualizationPanel.tsx::AntennaPublishedVisualization` używa istniejącego
`resolveInspectionRuntimeStage`, kontroli confirmed StageExecutionResource
i explicit selektora przy wielu wykonaniach. Authored `stageId` pozostaje ID
definicji; osobne `runtimeStageId` oraz `runId` są małymi, nietrwałymi polami
display intent. Nie kopiują server resource ani danych liczbowych do store'a.
Wspólny `antennaFieldIntent.ts::antennaInspectionIntentMatchesOwner` wiąże
scope/run/oba stage IDs/source/port/output/record digest/package digest/revision,
qualification i field scope. `useAntennaFieldOverlay` odczytuje exact runtime
ID, odrzuca stare intent bez tego ID oraz refreshError; nie zgaduje zgodności.
Żadne nowe quantity ani równania fizyczne nie zostały dodane.

Weryfikacja aktualnych źródeł: TypeScript `tsc --noEmit --incremental false`
z `tsconfig.typecheck.json` PASS (exit 0), scoped ESLint czterech plików PASS,
API hygiene PASS, architecture hygiene PASS, rustfmt providera/rejestracji
PASS i global `git diff --check` PASS. Negatywne regresje identity w
`antennaFieldIntent.test.ts` i providera są zapisane, ale zgodnie z zakazem
nie uruchamiano ani nie kompilowano unit testów. Starszy seq 61 nadal queued;
nie zawiera nowego providera ani tej poprawki frontendu. Kompilacja Rust i
runtime aktualnego fragmentu pozostają **NOT VERIFIED**.

Odczyt istniejącej karty na 3197 pokazał obecnie pusty model (Objects 0),
nie wcześniejszą scenę microstrip. Read-only DOM potwierdził widoczny canvas
o atrybutach 444×381. Browser API nie udostępniło `getContext`, a screenshot
zakończył się `Unable to capture screenshot`; nie dowodzi to stanu WebGL,
drawing buffer ani wizualnej poprawności V/J/H. Browser qualification nadal
**NOT VERIFIED**. Nie odtwarzano modelu, nie przeładowywano strony i nie
restartowano procesu użytkownika.

Kolejny krok pozostaje pełny: accepted provider→jawny OpenAPI owner/scope
kontrakt→generated client→resource hooks→wspólna projekcja metadata/display/
binary i pinned wybór wyniku→RAM accepted runtime gate→browser V/J/H.
Nie wolno uznać naprawy mapowania legacy ID za ukończenie accepted UI ani T14/T15.

**Checkpoint T14/T15, 2026-10-11 — wykonanie inspection przez accepted Study:**

Flat Study i pipeline deklarują wspólny, pojedynczy port `inspection/Artifact`
dla primitive `antenna_field_solve`. Nie deklarują magnetyzacji, magnetycznego
stanu wejściowego ani horyzontu LLG. Regresja pipeline zachowuje odrębność ID
węzła Study (`antenna-field-solve:antenna-solve`) i native stage ID
(`antenna-solve`); ich utożsamienie byłoby błędem normalnej ścieżki UI.

Dedykowany `accepted_antenna_inspection_worker` jest zarejestrowany w obu
binary roots API. Dispatch i admission obejmują tylko typed
`AntennaExternalLeadInspection`, FEM CPU lub requested auto, double, strict,
jeden port artifact, bez inputs i czasu końcowego. Requested auto pozostaje
w provenance, resolved execution musi być native FEM CPU bez fallbacku.
Legacy FieldBasis nie jest automatycznie promowany do inspection.

Przed solve sprawdzane są immutable accepted request, preparation binding,
certyfikat H1/P1, ponownie zmaterializowany plan, native runtime preflight
i budżet wyjściowy. Jednorazowy solve zwraca retained V/RT0/H/J w pełnym
FMANTPK1. `completed_step_count=1` oznacza jedną operację inspection,
nie krok LLG. Stop jest obsługiwany przez istniejący control loop i typed
cancellation; obliczenie natywne nie jest preemptive. Obowiązują wspólne
started/completed receipts, CAS, lease/epoch fencing i kontrola budżetu.
Recovery weryfikuje cały pakiet względem planu bez ponownego solve;
started bez completed nadal nie uprawnia do ponownego wykonania.

Domknięto także eksport dla świeżego wykonania z jawną polityką output storage:
przed completed receipt plan-bound pakiet przechodzi przez istniejący
`publish_antenna_inspection_package_atomically` do prywatnego staging root.
`AcceptedProjectStorage::finish` publikuje ten sam manifest i binarne payloady
w katalogu projektu, zamiast eksportować wyłącznie `m_final.json`.
To kopia użytkowa; authoritative output pozostaje w CAS. Nie skanuje się
katalogu attempt ani nie zmienia zabezpieczeń SessionStore. Legacy request
bez output_storage zachowuje wcześniejszy kontrakt CAS-only. Recovery completed
receipt nie naprawia automatycznie uprzednio nieudanego eksportu użytkowego;
bramka awarii publikacji i jej jawnego odzyskania pozostaje do kwalifikacji.

Zapisano negatywne regresje portów, requested/resolved intent, niedozwolonych
backendów/precision/mode i primitive Run. Zgodnie z zakazem repozytorium nie
kompilowano ani nie uruchamiano unit testów. Formatowanie i `git diff --check`
PASS. Kompilacja oraz accepted Study runtime, CAS→zasoby anteny i przeglądarka
pozostają **NOT VERIFIED**. Starszy build seq 59 jest nadal queued i nie
zawiera tego fragmentu; runner przyjmuje joby, seq 55 jest running.
Sceny użytkownika na localhost:3197 nie restartowano ani nie zmieniano.

Zlecono spójny managed `fem-cpu-release` seq 61, job
`22d2a7df30284bb8a89dd8a31d2a7134`, HEAD
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`, source digest
`4431d6a3a0e94acb44a1f7da38d637f0230577cab3b07bd2be592ff47ef72d8d`,
native snapshot
`ac265e63b01b40778f6e9470e20cda24dd308bcdcab183751d04eb9278c4a419`.
Capture zawiera 25 jawnych nieśledzonych wejść zadania, oba binary roots,
projekcję output ports, worker oraz eksport staging. Przy zgłoszeniu `queued`;
to nie jest dowód ukończonego buildu. Interpretowana kontrola źródeł potwierdza
granicę zależności neutralnego crate'a, registration obu binary roots,
staging-before-receipt i brak magnetycznego state/observation output.
Wpis identyfikatorów dodano po capture.

Zakres kontroli formatowania PASS: nowy adapter, accepted study worker
i trzy zmienione pliki authoringu. Szerszy `rustfmt --check` obu binary roots
i runtime-control zgłasza różnice kolejności modułów oraz istniejącego stylu
formatowania w dirty źródłach; ta szersza kontrola **FAIL**. Nie wykonano
masowego reformatowania pozostałego WIP. `git diff --check` całego checkoutu
pozostaje PASS. Żaden z tych wyników nie zastępuje kompilacji.

**Następny fragment T14/T15 — accepted CAS → zasoby i wizualizacja:**

Odczyt kodu potwierdza brak tej integracji. W
`crates/fullmag-api/src/router_v2/handlers/data/antenna_inspection.rs`
`snapshot`/`capture` korzystają wyłącznie z current-live `stage_execution`,
a `read_registered_record` wymaga wpisu artifact_refs i recordu
`antenna/external_lead_stage_outputs/{runtime_stage_id}/antenna_external_lead_stage_output.v1.json`.
Sam eksport `external_lead_solutions` ani typed CAS output tego nie wytwarza.
`handlers/simulation/runtime.rs::get_stage_execution` również nie projektuje
accepted RunCatalog. Nie wolno obchodzić tej granicy sztucznym recordem CLI.

1. Dodać provider accepted output oparty na autorytatywnym SessionStore,
   RunCatalog i `FmsStudyOutputManifest`, odrębny od legacy current-live.
   Wzorzec admission odczytu: `handlers/data/observation_frames.rs`
   (`load_observation_frames`, `active_run_id`), bez kopiowania magnetycznej
   semantyki observation/state. Wymagać succeeded aktualnej próby, Published,
   zgodnych run/task/Study step/attempt/ownership epoch, port/case/codec,
   rejestracji artifact ID, CAS SHA i pełnego accepted plan binding.
2. Ustalić jawny owner/scope kontrakt zasobów metadata/display/binary i OpenAPI.
   Identity musi wiązać accepted run/task/step/attempt/epoch, manifest/CAS,
   package digest oraz native solve/output ID. ETag i revision wynikają
   z autorytatywnego ownera; nie nadawać nowego live scope starym danym.
   Reuse wspólnego dekodera i projekcji V/J/H, nie drugi format pól.
3. Naprawić wybór wykonania w
   `apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationPanel.tsx`
   (`AntennaPublishedVisualization`): obecnie authored stage ID jest przekazywany
   jako runtime stage ID i porównywany z `raw.runtime_stage_id`.
   Istniejący `AntennaExternalLeadInspectionModel.ts::resolveInspectionRuntimeStage`
   obsługuje różnicę ID dla CLI, lecz jeszcze nie accepted provider.
   Typowany klient, resource hooks, panel i overlay muszą współdzielić jeden
   jawnie wybrany, pinned wynik; wiele wykonań wymaga selekcji użytkownika.
4. Bramka RAM: accepted solve→Publish→metadata→binary V/J/H, recovery bez solve,
   odrzucenie starego scope/run/epoch/CAS, niewidoczność Stop/nieopublikowanej
   próby, odmienne trzy rodzaje ID, wiele wykonań i stale payload po selekcji.
   Następnie browser smoke: canvas/WebGL/drawing buffer i przełączanie V/J/H.

Ten fragment jest zaplanowany na podstawie źródeł, **nie zaimplementowany**.
Nie nadaje kwalifikacji bazy na amper, source FFT ani LLG drive. Należy zachować
`raw_authored_current`, `external_electrode_truncation` oraz jawne ograniczenia
naukowe inspection. Nie oznaczać modułu ani przepływu UI jako ukończonego.

**Checkpoint T14/T15, 2026-10-11 — wspólny kodek manifestu/pakietu i granica Study:**

Neutralny `fullmag-antenna-artifacts::solution` przejmuje manifesty v1/v2,
ich ścisłą walidację oraz pełny retained loader V/RT0/H/J. `package` przejmuje
kodowanie/dekodowanie `FMANTPK1`. Runner zachowuje dotychczasowe publiczne
sygnatury z `RunError`, adaptery borrowed payload views oraz przenoszenie
owned payloadów bez kopii przy decode. Geometry display pozostaje dostępne
przez facade; request/plan binding, solve i publikacja filesystem pozostają
w runnerze. Nie wprowadzono kolejnego formatu ani osłabionego importera.

Application rejestruje dokładnie tuple
`artifact / fullmag.antenna.inspection_package / v1` oraz wariant
`DecodedStudyArtifact::AntennaInspection`. Zgodność bajtów z zewnętrznym CAS hash
jest sprawdzana przed odczytem pakietu. Self-describing decoder wydobywa
wewnętrzną referencję ze ścisłego manifestu i deleguje do pełnego pinned decoder;
nie dowodzi pochodzenia, freshness, zgodności z requestem ani kwalifikacji bazy
na amper. Dwa źródłowe regression checks obejmują exact tuple/framing oraz
kolejność CAS-before-decode. Nie kompilowano ani nie uruchamiano unit testów.

Neutralny crate potrzebuje teraz `fullmag-ir` dla kanonicznych typów manifestu,
lecz nadal nie zależy od runnera, application, planera ani MFEM/FFI. Application
zależy od neutralnego crate'a. Interpretowana kontrola lokalnego grafu zależności
i Cargo.lock wykazała brak cyklu oraz zgodność nowych lokalnych zależności.

Wykonanie przez accepted Study **nie jest jeszcze dopuszczone**: istniejące
guards runtime oraz output binding pozostają zamknięte do implementacji
dedykowanego inspection worker, deklarowanych artifact outputs i odczytu CAS
przez zasoby anteny. Sam wpis kodeka nie oznacza działającej komendy UI.
Build seq 58 nadal był `queued` w tej kontynuacji i nie zawiera tego fragmentu.
Kompilacja, runtime i browser qualification aktualnych zmian pozostają
**NOT VERIFIED**; sceny na 3197 nie zmieniano.

Kontrole tego fragmentu: porównanie źródłowe czternastu funkcji metadata/loader
i wydzielonego parsera manifestu, pięciu native adapter functions oraz dwóch
plan/request binding functions PASS po wyłącznie zmianach typów/importów
i adapterach payload views. Encoder i pomocnicze framing functions zachowują
format. `rustfmt --check` i `git diff --check` PASS; wyszukiwanie nie wykazało
zależności runner/plan/FFI/filesystem w neutralnych solution/package.
Dwie dodatkowe źródłowe regresje pakietu obejmują bounded/versioned framing
oraz duplicate JSON keys przed wydobyciem self-reference. Nie były uruchamiane.

W tej kontynuacji API runnera potwierdziło seq 53 jako `succeeded`, exit 0,
job `6b4e16db7616430f96c98dd11e09a899`. Jest to starszy snapshot pipeline/port
binding, nie dowód kompilacji obecnej ekstrakcji, application codec ani runtime.

Zlecono spójny `fem-cpu-release` seq 59, job
`d4d091b5fc4247eba8d91653c189f459`, HEAD
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`, source digest
`babd04d2904bcc2e60eacd5a025f725528d260324bdfb51c70d055f059a61f56`,
native snapshot
`afad3672c089045653f03846e6cb5f4b6791fa857b039e5476c31cc94eac089a`.
Capture zawiera 24 jawne untracked wejścia zadania oraz całą ekstrakcję i kodek
application. Przy zgłoszeniu stan `queued`; nie jest to receipt ukończonego
buildu. Wpis z identyfikatorami dodano po capture.

**Checkpoint T14/T15, 2026-10-11 — neutralny odczyt bundle i gęstości prądu:**

Kontynuacja ekstrakcji obejmuje `fullmag-antenna-artifacts/src/bundle.rs`
oraz `current_display.rs`: pełny odczyt zachowanego V/RT0/H, bilanse
komponentów/elementów/ścian, diagnostykę kwadratury oraz cell-local próbki J.
Runner korzysta z delegujących facade'ów z zachowaniem `RunError`.
Typy boundary/branch/quadrature należą do neutralnego właściciela; native
request, preflight, wiązanie wyniku do requestu i solve pozostają w runnerze.
Format binarny, jednostki, normalizacja i zakres `inspection_only` nie zmieniają
się. J nie jest uśredniane na wspólnych wierzchołkach ani rekonstruowane ponownie.

Neutralny crate nadal nie potrzebuje `ProblemIR`, MFEM, FFI, runnera ani
application. Istniejące fixture'y request-bound pozostają przy runnerze;
produkcyjny dekoder jest jeden. Sama ekstrakcja nie włącza jeszcze Study codec,
accepted inspection worker ani CAS read-adapter. Manifest i FMANTPK1 wymagają
kolejnej ekstrakcji przed podłączeniem tego samego walidatora do application.

Build seq 57 nadal był `queued` przy odczycie stanu w tej kontynuacji i nie
obejmuje powyższych nowych plików. Kompilacja i runtime tego fragmentu pozostają
**NOT VERIFIED**. Nie uruchamiano ani nie kompilowano testów jednostkowych.
Nie restartowano sceny użytkownika na porcie 3197.

Weryfikacja źródeł: pełne porównanie pure bundle i J po normalizacji
whitespace/importów/widoczności/error type PASS; bramki, komunikaty i algorytmy
pozostały niezmienione. `rustfmt --check`, `git diff --check` oraz interpretowana
kontrola zgodności workspace/package/runner/Cargo.lock i neutralnej granicy
zależności PASS. Request-bound fixture'y pozostają przy runnerze; pomocnicze
`key`, `current_gate`, `Sum` są tam dostępne wyłącznie pod `cfg(test)`.

Zlecono zwykły `fem-cpu-release` seq 58, job
`f47fead0ceb34bb99b3b1e129f02f805`, HEAD
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`, source digest
`8f7114ee6b329905e4a73bc9eed304c084a3d13862b70a79dcbe83f4008134c1`,
native snapshot
`96f81634962d734b345e55c925d002cdb017ea7d3dcbcc4a3590fcd49546cd22`.
Capture obejmuje 22 jawnie wskazane untracked wejścia zadania, w tym nowe
bundle/current-display. Stan po zgłoszeniu `queued`; terminalny build receipt
i runtime nadal do sprawdzenia. Ten wpis identyfikacyjny powstał po capture.

**Checkpoint T14/T15, 2026-10-11 — rozpoczęta ekstrakcja neutralnych artefaktów:**

Utworzono `crates/fullmag-antenna-artifacts` jako członka workspace i zależność
runnera. Pierwszy przeniesiony podsystem: `charge.rs` zawiera pełny dotychczasowy
dekoder retained charge, bounded `Reader`, typy rekordu i interface oraz stałe
limitu/schema/operator. Crate zależy wyłącznie od serde/serde_json/sha2; nie ma
MFEM, FFI, runnera, application ani wykonywania solvera. Runnerowy
`native_fem/accepted_terminal_charge/record.rs` jest cienkim facade'em; zachowuje
sygnaturę dekodera z `RunError`, a konwersja `ArtifactError` zachowuje message.
Request, pakowanie, solve i weryfikacja względem native requestu pozostają
w dotychczasowym ownerze. Limit 128 MiB i assertion zgodności z ABI zachowano.

`artifact_json.rs` przeniesiono do tego samego neutralnego właściciela, a runner
re-eksportuje istniejący parser. Wszystkie dotychczasowe artifact readers nadal
odrzucają duplicate JSON keys; dodano dwie źródłowe regresje top-level/nested/array
oraz odczytu unambiguous wartości. Trzy istniejące regresje charge przeniesiono
razem z dekoderem, nie usunięto pokrycia. Mechanical source comparison po
zmianie importów/widoczności/error type i formatowaniu wykazało niezmieniony
dekoder, bramki, komunikaty oraz testy. Parser Rust i diff-check PASS.
Unit testów nie kompilowano ani nie uruchamiano. Typecheck i runtime ekstrakcji
pozostają NOT VERIFIED. Cargo.lock aktualizuje wyłącznie nowy lokalny package
i zależność runnera; bez zmian wersji zewnętrznych zależności.

To **pierwsza część**, nie kompletny codec anteny: bundle/current-display,
manifest i FMANTPK1 nadal są w runnerze. Application nie dopuszcza jeszcze
inspection artifact. Kolejne kroki: wydzielić ich pełne czyste dekodery,
zachować runnerowe request-bound adapters, podłączyć ten sam decoder do Study
codec, następnie output binding/accepted inspection dispatch i CAS read-adapter.
Aktualne źródła są późniejsze niż seq 56; jego build nie weryfikuje ekstrakcji.

Zlecono normalny `fem-cpu-release` seq 57,
job `42a5ccb122a54981b2cc967fe5407eb7`, HEAD
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`, source digest
`92a2c1a880e11b56af37ba4d1186c2655174da2604b8bd83c3a1225ac77befa2`,
native snapshot `a59cafc4e03f03a587c3264791af18c9baf526af1bbd418027af2a070d058d93`.
Capture obejmuje cztery nowe pliki neutralnego crate'a i szesnaście wcześniejszych
untracked plików zadania. Zawiera także walidację package względem execution plan
powstałą po seq 56. Przy zgłoszeniu queued; terminalny build receipt i runtime
pozostają do weryfikacji. Kontrola TOML workspace/package/runner/Cargo.lock PASS.

**Checkpoint T14/T15, 2026-10-11 — wiązanie retained package do rzeczywistego inputu:**

`package.rs::load_antenna_inspection_package_for_execution_plan` wymaga dokładnie
`AntennaExternalLeadInspection`, właściwego requested/resolved FEM i trybu,
zgodności stage/output oraz ponownego materializowania authored inputu przez
istniejący planner. Następnie dekoduje i waliduje cały pakiet oraz porównuje
manifest z input pins, source/transport/port/drive, solver policy, execution,
closure revision, sampling carrier, dokładną kolejnością device vertex IDs
i współrzędnymi próbkowania. Nie przyjmuje magnetycznego planu.

Samo skopiowanie input pins do manifestu nie wystarcza: `validate_retained_input`
używa istniejącego `with_materialized_external_lead_request` i
`validate_bundle_request`. Ten validator porównuje retained charge z faktycznym
requestem, podział device/lead, boundary role/circuit, branches, targety i
quadrature policy. Nie wywołuje solve. Na kompilacji bez feature native FEM
request binding odmawia działania; ogólny dekoder pakietu pozostaje osobny.
To wiązanie nie zastępuje zewnętrznego CAS hash, accepted run/step, lease/epoch
ani kwalifikacji naukowej. Walidacja obejmuje dodatkowy bounded decode bundle;
nie jest cache ani ścieżką wykonywaną w hot loop LLG.

Dodano źródłową regresję odmowy magnetycznego FDM przed odczytem payloadu.
Parser Rust/diff-check PASS, bez kompilacji testów jednostkowych. Cała ta zmiana
jest **po snapshot seq 56**; jego przyszły wynik nie dowodzi kompilacji nowej
funkcji. Accepted worker i endpoints jeszcze jej nie wywołują.

Read-only review granicy codeca wykazało, że application nie może importować
runnera, a quantities nie może importować IR (cykl: IR już korzysta z quantities).
Przed rejestracją inspection codeca potrzebna jest ekstrakcja istniejącego
pełnego retained-result decodera do neutralnego właściciela, bez FFI i solve:
manifest/reference, duplicate-safe JSON, charge/bundle/current-display records
i package framing. Nie tworzyć drugiego tolerancyjnego dekodera ani opaque JSON.
Proponowany nowy crate `fullmag-antenna-artifacts` **jeszcze nie istnieje**;
API runnera ma zachować zgodność przez re-export/conversion wrappers.
Nowy application codec będzie mógł używać tego samego pełnego walidatora;
self-reference manifestu nie zastąpi wiązania do przyjętego planu.
Ta ekstrakcja jest kolejnym krokiem implementacji, nie ukończonym komponentem.

**Checkpoint T14/T15, 2026-10-11 — pakiet wyników i rzeczywisty warm/cold API:**

`crates/fullmag-runner/src/antenna_external_lead_solution/package.rs`
dodaje `encode_antenna_inspection_package` i `decode_antenna_inspection_package`.
Format: magic `FMANTPK1`, długość manifestu u64 LE, dokładne bajty manifestu,
a następnie długość u64 LE i bajty każdego payloadu w stałej kolejności
deskryptorów manifestu: bundle, pozycje, H, identyfikatory wierzchołków, V,
opcjonalnie current_display v2. Pakiet nie przechowuje dowolnych nazw plików;
schema walidatora wyznacza dokładny zestaw pięciu/sześciu payloadów.
Limit wynika z istniejących ograniczeń: 1 MiB manifestu i do sześciu
payloadów po 128 MiB, z narzutem framingu. Budżet CAS/workera pozostaje
odrębną, potencjalnie ostrzejszą bramką. Duże bufory używają fallible reserve.

Dekoder odrzuca skrócone dane, niezgodne długości, nadmiarowe końcowe bajty,
złą tożsamość i uszkodzone payloady. Obie strony korzystają z istniejącego
pełnego walidatora manifestu, hashy i zgodności V/RT0/H/J. Nie jest to
kwalifikacja aktualności modelu, bazy per-A, LLG ani FFT. Zewnętrzny digest
CAS dokładnych bajtów pakietu nie jest semantic `content_digest` wyniku;
caller musi zweryfikować oba oraz wiązanie przyjętego wykonania.

`publication.rs::publish_antenna_inspection_package_atomically` łączy odczyt
pakietu z dotychczasową atomową publikacją immutable revision, bez solvera.
Sprawdza cancellation przed/po dekodowaniu; błędny pakiet nie tworzy plików.
Nie zmienia istniejącego zestawu plików ani formatu stage record.
Dodano cztery źródłowe regresje: byte-exact round-trip v1/v2 i deterministyczna
kolejność, uszkodzenia/framing/tożsamość, brak/duplikaty/path traversal oraz
publikacja/reuse/cancellation bez częściowego zapisu. Parser Rust i diff-check
PASS; testów jednostkowych nie kompilowano ani nie wykonywano zgodnie z zakazem.
Te zmiany są późniejsze niż snapshot seq 55. Codec application/CAS, dispatch
accepted workera i nowe endpointy nie są jeszcze podłączone.

Zlecono zwykły build `fem-cpu-release` seq 56,
job `4dc9fed201aa4a04a97b155999394321`, ze snapshotu HEAD
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`; source digest
`a6c9bf8cc42446a36667d4a1d1f9df9403adfb85c5fe83053964edeb409026df`,
native snapshot `e6da8f8672298d3467fee8943902f50d3452f026dc48fd9dab71bdf524ab0e15`.
Capture obejmuje nowy package, adapter publikacji i wcześniejsze WIP, z jawnie
wskazanymi szesnastoma untracked plikami zadania. Przy zgłoszeniu `queued`;
nie jest dowodem kompilacji ani runtime nowego pakietu. Następny krok:
terminalny receipt i weryfikacja buildu, następnie podłączenie wersjonowanego
codeca do output binding/CAS oraz oddzielnego accepted inspection workera.

**Wykonany dowód runtime, odrębny od powyższego nowego pakietu:** managed build
seq 51 `5f67b9064e8f466dbc6689abe1d55ba6` zakończył się `succeeded`, exit 0.
Recepta `just run-managed-antenna-standalone-cold-http-ram` zweryfikowała receipt,
źródła i pakiet oraz uruchomiła wyłącznie zatwierdzoną scenę anteny w tmpfs.
Run `d13d6b1cc2cc41e193bbd5135fcbdf57`: solver exit 0, warm HTTP PASS,
cold archive import PASS, ponowny odczyt natywnego bundle PASS. V/J/H i topology
przeszły odczyt przez API przed/po imporcie; `m`, `H_eff`, `H_demag` są unsupported
w obu read-modelach. W trakcie importu pierwotny root wyników był niedostępny;
stary request scope został odrzucony. Procesu API nie restartowano.
Dowód: `storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/managed-antenna-http-ram-cpu/runs/d13d6b1cc2cc41e193bbd5135fcbdf57/receipt.json`
oraz `export/gate-result.json`. Nie dowodzi trwałości sesji, zmiany sceny
magnetycznej na antenową, poprawności browser/WebGL, pełnej naukowej kwalifikacji
ani reuse LLG/FFT; odpowiednie flagi wyniku nadal false. Nie zmieniono localhost:3197.

**Checkpoint T14/T15, 2026-10-11 — capture wykonania i zależności workera:**

`crates/fullmag-api/src/script.rs::scene_document_to_prepared_script_config`
jest jawnym capture pełnego authored graph przez istniejący Python DSL.
`SceneCaptureKind::PreparedExecutionConfig` używa wyłącznie
`export-scene-config --materialize-geometry-assets`. Dotychczasowe
`ProblemIr` i `ExecutionConfig` nie dostają flagi i zachowują lekki eksport.
Nie dodano wyboru pierwszego etapu/portu, drugiego meshera ani wykonania solvera.
Wybór konkretnego source step, wiązanie profili i gotowość pozostają zadaniem
callera; **nowego capture nie podłączono jeszcze do endpointu ani Study compiler**.
Dodano źródłową regresję rozdzielenia trzech trybów helpera.
Parser Rust/diff-check PASS; test Rust nie był kompilowany ani wykonywany.
Zmiana jest późniejsza niż capsule seq 55.

Read-only przegląd rzeczywistego workera doprecyzował kolejność dalszej pracy:

1. `accepted_study_worker.rs::expected_output_binding` weryfikuje porty
   przed dispatch i wspiera tylko magnetyzację oraz total_energy.
   `fullmag-application/src/execution.rs::is_supported_study_artifact_codec`
   i `study_artifact.rs::DecodedStudyArtifact` również nie mają inspection.
   Najpierw potrzebny jest jawny wersjonowany artifact codec dla inspection;
   nazwa nowego codeca/portu nie jest istniejącym API.
2. `AntennaExternalLeadSolutionArtifact` zawiera manifest i osobne binarne
   payloady. Sam JSON manifest z nazwami plików nie wystarcza do cold CAS
   recovery. Preferowany minimalny kontrakt: jeden bezstratny ograniczony
   pakiet manifest+payloady, z dokładnymi bajtami, długościami, SHA256,
   odrzuceniem duplikatów, path traversal i nieoczekiwanych plików.
   Warstwa application pozostaje bez zależności solverowej; runnerowy
   `load_antenna_external_lead_solution_manifest` i dekodery sprawdzają
   semantykę naukową pakietu w adapterze wykonania/odczytu.
3. Osobny adapter accepted inspection wywoła istniejący
   `fullmag_runner::execute_antenna_external_lead_inspection`, bez LLG,
   final_state, horyzontu czasu i magnetycznego accepted state. Native solve
   jest niepreemptive: cancellation musi być sprawdzone przed/po solve
   oraz przed publikacją. Nie każdy błąd solvera oznacza anulowanie.
4. Dopiero z gotowym codec/output/adapter można zastąpić jawny rejection
   w `study.rs::validate_requested_execution` walidacją legalnego requestu
   inspection i dodać dispatch według rzeczywistego backend_plan.
   Magnetyczne guards `accepted_fem_study_worker` pozostają osobne.
5. Zachować immutable started/completed receipts, CAS budget, deklarację
   portów, lease/epoch fences, Completing barrier i recovery bez powtórnego
   solve. Started-only ambiguity nie upoważnia do ponowienia solvera.
6. CAS publikacja musi mieć adapter do obecnych endpointów inspection;
   nie tworzy automatycznie CLI stage record. Dowodem końcowym będzie warm
   oraz cold odczyt V/J/H, brak magnetycznych quantities i zachowanie Stop.

Plan tej ścieżki nie oznacza jej implementacji ani kwalifikacji LLG/per-A/FFT.
Wymagane regresje: niewłaściwy plan/port/receipt przed solve, zmienione/brakujące
payloady, przekroczony budget, cancellation, stale lease/epoch, cold recovery
bez solvera, started-only odmowa i brak regresji magnetycznego workera.
Przy odczycie seq 51 running, seq 55 queued; istniejących jobów nie restartowano.

**Checkpoint T14/T15, 2026-10-11 — accepted preparation bez odblokowania LLG:**

`crates/fullmag-runtime-control/src/study.rs::AcceptedStudySnapshot::materialize_antenna_external_lead_inspection_preparation_receipt`
korzysta z osobnego konstruktora inspection. Wspólna prywatna ścieżka z
dotychczasowym przygotowaniem magnetycznego FEM zachowuje exact step lookup,
status Planned, niezmienny katalog ProblemIR, ponowne planowanie i porównanie
z pinned plan, fingerprint RunSpecification, źródło accepted run/step v2
oraz `PreparationReceipt::ready_for_accepted_run`. Dotychczasowa metoda
`materialize_fem_preparation_receipt` nadal wybiera tylko constructor time-domain.

`crates/fullmag-api/src/accepted_fem_preparer.rs::accepted_preparation_mesh`
wybiera własną siatkę/order dla Fem, a `input.combined_mesh` i order 1 dla
inspection; inne warianty odrzuca. `prepare_accepted_fem_task` wybiera właściwą
metodę receipt bez zmian w walidacji lease/attempt, replay, lifecycle,
aktywnym lease, atomowym zapisie i końcowym ponownym odczycie receipt.
Dodano źródłową regresję zachowania mesh/order magnetycznego Fem i odrzucenia
Fdm. Parser Rust i diff-check PASS; regresji nie kompilowano ani nie wykonano.

**Istotna otwarta zależność:** `load_accepted_study_snapshot` wywołuje
`validate_requested_execution`, która nadal jawnie odrzuca inspection.
Nowy branch preparera nie jest więc jeszcze osiągalnym trwałym workflow
anteny. `accepted_fem_study_worker.rs::validate_fem_cpu_request` i
`validate_native_fem_cpu_preflight` również wymagają dokładnie magnetycznego
Fem; tych bramek nie rozluźniono. Osobne wykonanie inspection musi dostać
właściwy kontrakt request/provenance/worker/artifacts przed dopuszczeniem.
Nie należy jedynie usuwać rejection albo przepuszczać inspection do LLG.
Read-only review subagenta potwierdziło te zależności w rzeczywistych źródłach.

Ten fragment powstał **po capture seq 55** i nie należy do jego kapsuły.
Przy odczycie runnera seq 51 nadal running, seq 55 queued. Kompilacja,
runtime replay i kompletna ścieżka browser-to-solve pozostają NOT VERIFIED;
bez nowego endpointu/OpenAPI, bez restartu localhost:3197 i bez zmiany fizyki.

**Checkpoint T14/T15, 2026-10-11 — osobny kontrakt przygotowania źródła:**

`crates/fullmag-plan/src/preparation.rs::PreparationMaterialization`
ma osobne konstruktory
`from_antenna_external_lead_inspection_execution_plan` i
`from_antenna_external_lead_inspection_execution_plan_for_accepted_run`.
Wymagają dokładnie wariantu `AntennaExternalLeadInspection`, zgodności
requested backend oraz resolved FEM. Weryfikują native evidence dla
`input.combined_mesh`, H1/P1, bez przypisywania raportu jakości pierwotnego
urządzenia do siatki z doprowadzeniami. Wspólny prywatny producer zachowuje
dotychczasowe pięć certyfikatów, walidację markerów, DOF, Jacobianu i fingerprintów.
Stare konstruktory time-domain FEM nadal odrzucają wariant antenowy.
Accepted constructor zachowuje źródło run/step v2 bez Live scene revision.

`crates/fullmag-application/src/preparation.rs::materialize_antenna_external_lead_inspection_preparation_from_problem`
planuje kanoniczny ProblemIR i wiąże receipt z pełnym fingerprintem problemu,
geometrią oraz display projection. Odrzuca nieobiektową projekcję, zerową
rewizję oraz magnetyczny plan FEM. Jest eksportowany przez application API,
ale **nie podłączono go jeszcze do Live/accepted materializer ani UI readiness**.
Nie zmieniono lease/replay ani zabezpieczeń Run/Relax.

Dodano cztery regresje źródłowe w
`crates/fullmag-plan/src/antenna_current_source.rs::tests` wykorzystujące
rzeczywisty istniejący fixture planu inspection: combined vs original mesh,
typed variant/backend guards, błędny native producer/order/DOF/Jacobian/marker
correspondence oraz accepted identity. Native evidence jest jawnie syntetyczną
fixture kontraktu, nie wynikiem uruchomienia MFEM. Piąta regresja w
`crates/fullmag-application/src/preparation.rs::tests` sprawdza odrzucenie
nieprawidłowych wejść Live i magnetycznego planu.

Dowody bieżącego fragmentu: parser Rust przez `rustfmt --emit stdout` PASS,
diff-check PASS, review źródeł i konsumentów. **Testów Rust nie kompilowano
ani nie wykonano** zgodnie z tymczasowym zakazem; typecheck/build/runtime
nowego fragmentu pozostają NOT VERIFIED do terminalnego buildu i właściwych
bramek. Receipt H1 nie dowodzi rozwiązania V/J/H, RT0, zamkniętego obwodu,
normalizacji per-A, FFT ani kwalifikacji sprzężenia LLG. Scena localhost:3197
nie została zmieniona ani zrestartowana.

Snapshot tego fragmentu wraz z wcześniejszym WIP zgłoszono do jednego
runnera jako **seq 55**, job `713429ba647141248db59382c09522a7`, profil
`fem-cpu-release`, stan zgłoszenia `queued`, base HEAD
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`.
Source digest:
`6c508b09ca0f55a54c6b75d4f3c2fb605dfdda45fa35fb0814badc8ed7013313`.
Native snapshot:
`703524bf128d209d2994b35568a6d0fcee03edaf820e4c618882b5a658f16c23`.
Jawnie włączono 15 nieśledzonych plików wymaganych przez wcześniejsze WIP,
w tym composer i jego regresję DOM. Capture wykonano po zakończeniu zapisów
subagenta. Odczyt zdrowia runnera poza sandboxem: running/accepting_jobs true,
executor_error null; nie restartowano koordynatora. Sukces wymaga terminalnego
receipt i weryfikacji hashy artefaktów, nie samego przyjęcia zadania. Ten wpis
z numerem joba powstał już po capture; nie zmienia to tożsamości kapsuły.

**Checkpoint T14/T15, 2026-10-11 — geometry-full capture jako jawne opt-in:**

Zapisano lokalny commit etapu
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`:
`Preserve scene pipeline ownership and opt in to execution geometry`.
Obejmuje wyłącznie `scene_document_ir.py`, `helper.py` i
`test_scene_execution_config.py`, bez innych zmian worktree.

`packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py::scene_document_to_execution_config`
ma keyword-only `materialize_geometry_assets: bool = False`. Domyślnie
pozostaje geometry-light. Jawne True propaguje istniejącą opcję
`include_geometry_assets` do base IR oraz `RunConfigExportOptions`, więc
rzeczywiste etapy korzystają z dotychczasowego `Problem.to_ir` i jego
producerów geometrii/doprowadzeń. Nie wprowadzono drugiego meshera,
nowego ProblemIR ani fallbacku urządzenia. Nieboolean daje TypeError.
`helper.py::build_parser` i `main` udostępniają flagę
`export-scene-config --materialize-geometry-assets`; zwykły `export-scene-ir`
pozostaje bez tego opt-in. Nie podłączono jeszcze Rust Live/accepted caller.

Dowody: **28/28** interpretowanych regresji sceny oraz **32/32** testy
eksportu anteny, round-trip doprowadzeń i inventory z **35** podtestami PASS.
Pierwsze uruchomienie inventory odmówiło z powodu brakującego
FULLMAG_TEST_TEMP_ROOT; po wskazaniu istniejącego katalogu na D cały zestaw
przeszedł. Regresje nowego routing opt-in używają jawnych mocków producerów:
nie są dowodem zbudowania rzeczywistej siatki ani wykonania solvera.
Sprawdzają brak mutacji sceny, zachowanie requested backend, propagację do
każdego etapu, domyślny lekki eksport, typ flagi oraz argumenty helpera.
Przejrzano cały staged diff; staged/diff-check PASS. Commit nie oznacza
integracji z master ani kwalifikacji całego modułu.

Seq 51 nadal running, seq 53 queued przy ostatnim odczycie API. Ich kapsuły
mają wcześniejszy base HEAD i nie zawierają tego opt-in ani późniejszego
composera portu. Nie należy używać nowego HEAD jako pinu starszego buildu.

Doprecyzowany następny krok receipt: osobne konstruktory inspection w
`crates/fullmag-plan/src/preparation.rs::PreparationMaterialization` mogą
ponownie wykorzystać istniejące pięć producer kinds, certyfikaty i native
H1/P1 validation bez zmiany wire shape. Stare time-domain konstruktory
muszą nadal odrzucać inspection. Źródłem jest wyłącznie
`AntennaExternalLeadInspectionBackendPlanIR.input.combined_mesh`, order 1,
bez podpinania raportu jakości original device ani magnetic shared mesh.
Full ProblemIR fingerprint i immutable accepted identity wiążą sigma,
port, sampling i interfejsy; mesh/space reuse nie certyfikuje operatora
przewodnictwa. Receipt dowodzi przygotowania siatki/H1, nie RT0/V/J/H,
zamkniętego obwodu, per-A, FFT ani LLG. Materializacja Live/accepted,
lease/replay, właściwa readiness frontendu i runtime pozostają otwarte.

**Checkpoint T14/T15, 2026-10-11 — jawny wybór portu w Inspectorze:**

`apps/control-room/src/modules/inspector/panels/antenna/AntennaStudyStageComposer.tsx::AntennaStudyStageComposer`
jest częścią `AntennaCompositionPanels.tsx::AntennaCompositionPanel` dla
węzła solution. Pokazuje porty dokładnej definicji i dodaje do Study jeden
jawnie wybrany port przez istniejącą komendę i historię authoringu. Nie
kopiuje definicji, nie uruchamia transportu/LLG/Relax i nie certyfikuje pola.
Przy jednym porcie wybór jest jednoznaczny; przy wielu portach nie ma
automatycznego wyboru pierwszego. Zmieniona komenda
`antennaFieldSolveStudyCommand.ts::antennaFieldSolveStudyStages` przyjmuje
opcjonalny `portModeId`, sprawdza jego jednoznaczne członkostwo w definicji
oraz właściciela i transport. Powtórzenie tego samego wyboru jest idempotentne;
inny port przy już istniejącej referencji daje konflikt, nie nadpisanie.
Inspector etapu sprawdza jeden wybrany port w inventory, zamiast błędnie
wymagać równości z całym katalogiem portów definicji.

Lokalny stan zawiera wyłącznie wybór portu i feedback. Komenda odczytuje
autorytatywną scenę i zachowuje base_revision/Undo/session fences. Pending
dotyczy tylko przycisku enqueue; selektor i inne kontrolki nie są przygaszane.
ACK starej sesji lub opuszczonego targetu nie aktualizuje nowego panelu.
Źródłowe regresje obejmują multiport, niezmienność definicji, idempotencję,
konflikt, tożsamość selektora podczas refresh/pending/ACK i starą sesję.
TypeScript noEmit, targeted ESLint, API hygiene, architecture hygiene oraz
diff-check: **PASS**. Vitest/DOM **NIEWYKONANE**, browser **NOT VERIFIED**.
Te zmiany powstały po capture seq 53 i **nie są w jego kapsule**.

**Następny etap — dedykowana preparacja źródła, nie usunięcie guardów:**

Przegląd rzeczywistego kodu potwierdził niezależny producer wejść:
`packages/fullmag-py/src/fullmag/runtime/antenna_lead_materialization.py::materialize_antenna_lead_preparations`
oraz `packages/fullmag-py/src/fullmag/meshing/_antenna_external_lead_preparation.py::prepare_antenna_external_lead_source`.
Tworzą siatkę przewodnika/stubów i konserwatywne wejście prądowe; receipt
`input_prepared_not_solved` przy external_electrode_truncation nie kwalifikuje
zamkniętego obwodu, per-A, source FFT ani LLG. Nie należy opisywać go jako
wyniku rozwiązania V/J/H. Natywny
`crates/fullmag-runner/src/native_fem/mesh_preparation.rs::prepare_fem_mesh_space`
może przygotować H1/P1 na rzeczywistym combined_mesh bez magnetyzacji;
nie produkuje sam RT0 ani wyniku transportu.

Potwierdzone bariery do naprawy w jednej spójnej ścieżce:

1. `crates/fullmag-api/src/script.rs::scene_document_to_problem_ir` odmawia
   explicit FEM już przed plannerem. Nie wystarczy zmienić późniejszy guard.
2. Geometry-light capture w
   `scene_document_ir.py::scene_document_to_execution_config` nie wykonuje
   materializacji doprowadzeń. Potrzebna jest jawna execution-only trasa
   geometry-full, bez zmiany domyślnego lekkiego eksportu authoringu.
3. `live_scene_preparation.rs::materialize_live_scene_preparation`,
   `accepted_fem_preparer.rs::prepare_accepted_fem_task` oraz
   `preparation.rs::PreparationMaterialization::from_fem_execution_plan_with_identity`
   wymagają time-domain `BackendPlanIR::Fem`. Potrzebny jest osobny typed
   materializer dla istniejącego `AntennaExternalLeadInspection`, bez
   podmieniania planu na magnetyczny FEM i bez wyłączania lease/replay guards.
4. Receipt musi związać immutable step/port/current/source, input pins,
   stable IDs, sigma, interfaces, combined_mesh/native H1 oraz oddzielne
   sampling provenance. Gotowość raw inspection nie oznacza per-A/FFT/LLG.
5. Frontend musi rozróżnić source preparation i magnetic shared-domain
   preparation. Run/Relax zachowują dotychczasowe wymagania. Regresje muszą
   objąć zmianę geometrii/sigma/portu, obce native evidence, forced GPU,
   standalone oraz mixed pipeline i zachowanie magnetycznej continuation.

To otwarty zakres implementacji, nie gotowy produkt ani nowa kwalifikacja.
Sesja użytkownika na 3197 pozostała nienaruszona.

**Checkpoint T14/T15, 2026-10-11 — pusty pipeline bez ukrytego Run/Relax:**

`crates/fullmag-authoring/src/scene_study_plan.rs::scene_document_to_study_plan`
i `packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py::scene_document_to_execution_config`
respektują obecność kanonicznego dokumentu także przy pustych lub wszystkich
wyłączonych węzłach. Nie wznawiają dormant flat stages. Brak dokumentu albo
`null` zachowuje ścieżkę płaską. Nieobsługiwana wersja jest odrzucana.
Python odrzuca także nieobiektowy dokument i niepoprawny typ listy nodes.

Zgodnie z serde w `builder.rs::StudyPipelineDocument` pominięte version
oznacza `study_pipeline.v1`, a pominięte nodes pustą listę. Adapter
`studyStageSource.ts::readStudyStageSource` obsługuje te same defaults;
explicit null dla tych pól pozostaje błędem. Nie dopisuje defaults do
oryginalnego dokumentu. Polecenie
`antennaFieldSolveStudyCommand.ts::antennaFieldSolveStudyStages` sprawdza
ten adapter przed enqueue; nie waliduje dormant flat list jako wykonywanego
źródła i potrafi dodać węzeł do legalnego `{}`. Odmawia definicjom z zerem
lub wieloma portami, ponieważ obecne materializery obsługują dokładnie
jeden jawny port na etap. Nie wybiera pierwszego portu automatycznie.
Wybór jednego portu z definicji wieloportowej w UI pozostaje otwarty.

Interpretowany `test_scene_execution_config.py`: **20/20 PASS**. Istniejąca
regresja autosave wcześniej edytowała dormant flat payload przy aktywnym
pipeline; teraz osobno sprawdza round-trip rzeczywistego źródła flat i
pipeline, z tymi samymi wymaganiami dla table_id i expressions.
TypeScript noEmit, targeted ESLint, API hygiene, architecture hygiene
i diff-check: **PASS**. Regresje Rust/Vitest są zapisane, lecz zgodnie
z zakazem **NIEKOMPILOWANE/NIEWYKONANE**. Nowe zmiany nie są w kapsule 51.
Build 51 osiągnął stan running; nie jest jeszcze dowodem terminalnego
sukcesu. Browser, wykonanie aktualnej wersji, przygotowanie źródła,
pełny obwód, per-A, LLG/FFT i kwalifikacja wydania pozostają otwarte.

Aktualny snapshot zgłoszono jako **seq 53**, job
`6b4e16db7616430f96c98dd11e09a899`, profil `fem-cpu-release`, stan queued:
base HEAD `bbdf165066fc51a925e873f71f1f21ee943399e9`, source digest
`4afa3892120a40065c10cd4c5604a0617ec1e41c8060f08784867082708c8236`,
native snapshot
`2707892ce285f74a9255f6d2a7e956b679fe6129cf16b70efa6b444de658d9d7`.
Capture jawnie obejmuje wszystkie 13 nowych plików wymienionych w aktualnym
git status, w tym wspólny adapter, dedykowany Inspector i regresje.
To zwykły build backendu/frontendu, nie zadanie kompilacji testów.
Nie anulowano starszego joba ani nie zmieniono sesji użytkownika na 3197.
Po terminalnym sukcesie należy zweryfikować receipt/artefakty, wykonać
oddzielny standalone V/J/H warm+cold API gate oraz browser gate tej wersji;
sukcesy starszych kapsuł nie kwalifikują nowych zmian.

**Checkpoint T14/T15, 2026-10-11 — jeden wybór portu w obu materializerach:**

Po poprzednim checkpointcie ujednolicono źródłowo regułę wyboru portu:
`crates/fullmag-application/src/script_stage_materialization.rs::select_antenna_port_reference`
jest używany przez `resolve_explicit_stage_action` oraz
`materialize_pipeline_antenna_field_solve`. Dozwolony jest niepusty singular
przy pominiętym/pustym plural albo plural z dokładnie jednym niepustym stringiem
przy pominiętym singular. Oba niepuste pola są odrzucane, także gdy wskazują
ten sam port; identyfikatory nie są automatycznie trimowane ani podmieniane.
Pipeline sprawdza również typ plural, zamiast ignorować go przy singular.
Nieprawidłowy wybór kończy się przed wyborem inventory i mutacją current IR.

To celowe zaostrzenie wcześniejszej ścieżki pipeline, a nie migracja payloadu:
importy korzystające z dawnego ignorowania plural muszą jawnie usunąć
niejednoznaczne pole. Semantyka poprawnych singular/plural oraz format JSON
nie zmieniły się. `StudyStageAuthoringModel.ts::antennaFieldSolvePortReferences`
i `validateStudyStageDraft` stosują tę samą regułę; niepusty dual-form jest
błędem, nie tylko ostrzeżeniem. Inspector korzysta z tego samego helpera.

Dodano źródłowe regresje resolvera i odmowy bez mutacji oraz dopasowano
regresję UI. Rust/Cargo/Vitest **NIEKOMPILOWANE/NIEWYKONANE** zgodnie z zakazem.
TypeScript noEmit, targeted ESLint, API hygiene, architecture hygiene i
diff-check: **PASS**. Kompilacja zwykłego backendu i wykonanie tej poprawki
pozostają **NOT VERIFIED**; nie należy przypisywać jej wyników buildu 50 ani
kapsuły 51, utrwalonej przed zmianą. Build 51 nadal queued; źródłowa poprawka
nie zamyka bramek przygotowania anteny, pełnego obwodu, per-A, LLG/FFT ani UI.

**Checkpoint T14/T15, 2026-10-11 — odczyt kanonicznego pipeline i ochrona zapisu:**

Dodano wspólny adapter
`apps/control-room/src/shared/domain/study/studyStageSource.ts::readStudyStageSource`.
Korzystają z niego `sceneModelTreeAdapter.ts::sceneStudySnapshot`,
`StudyInspectorPanelModel.ts::studySnapshotFromScene` oraz kontroler
`StudyInspectorPanel.tsx::useStudyInspectorPanelController` i jego
`rawStudyStages`. Istniejący pipeline ma pierwszeństwo nad płaską listą,
również gdy jest pusty. Nieznana wersja, brakujące/duplikowane ID, nieprawidłowy
payload lub rodzaj węzła dają stan invalid, bez ożywienia dormant stages.
Makro czytane jest z `config`, nie z `payload`, i nie jest pozornie rozwijane.

Projekcja zachowuje kolejność liści, oryginalny payload/config, zewnętrzne ID,
etykietę, ścieżkę ID grup i efektywne enabled uwzględniające przodków.
Metadane adaptera pozostają poza publicznym payloadem. Węzeł anteny rozwiązuje
definicję przez oryginalne `payload.stage_id`, a wybór oraz telemetrię przez
outer ID. Explorer oznacza wyłączenie w badge; Inspector pokazuje efektywne
enabled i grupy. `sceneModelTreeAdapter.ts::modelTreeSnapshotWithStageExecution`
i `StudyInspectorPanelModel.ts::resolveStudyInspectorModel` nie fallbackują
na indeks dla węzłów pipeline. Aktywny indeks runtime jest tłumaczony przez
ID rzeczywistego runtime record, zamiast wskazywać inny authored leaf.

To etap inspekcji, **nie kompletna edycja strukturalna pipeline**. Szkice
pipeline są zachowane do odczytu, bez rekonstrukcji Run/Relax z defaultów.
Save jest wyłączony; toolbar płaskiej edycji nie jest dostępny.
`StudyStageAuthoringModel.ts::buildStudyStagesMergePatch` odmawia zapisu przy
pipeline z najnowszej sceny lub pipeline-bound draft. Komendy płaskiego
Add/Remove sprawdzają zasób i ponownie authoritative scene przed transakcją.
Dedykowane referencyjne enqueue anteny pozostaje osobną, zachowującą dokument
ścieżką. Pełna edycja musi aktualizować dokładny węzeł najnowszego dokumentu
z base_revision, zachowując grupy, rodzeństwo, makra, enabled/collapsed,
source/notes i oba rodzaje ID; ta część nadal jest otwarta.

Przegląd źródeł ujawnił dwa niezależne kontrakty wymagające dalszej naprawy:

- `crates/fullmag-application/src/script_stage_materialization.rs::materialize_pipeline_antenna_field_solve`
  nadaje pierwszeństwo `port_mode_id`; przy jego braku przyjmuje dokładnie
  jeden element `port_mode_ids`. `resolve_explicit_stage_action` odrzuca
  część kombinacji obu pól, zamiast stosować tę samą regułę. UI teraz
  odczytuje singular, zachowuje oba pola bez normalizacji i ostrzega o dual-form.
  Walidacja szkicu nie przedstawia wieloportowej instrukcji jako wykonawczego
  etapu obsługiwanego przez obecną ścieżkę. Backendowe ujednolicenie jest otwarte.
- `crates/fullmag-application/src/script_stage_materialization.rs::materialize_script_stages_with_stage_limit`
  respektuje pusty/all-disabled pipeline, ale
  `crates/fullmag-authoring/src/scene_study_plan.rs::scene_document_to_study_plan`
  oraz `packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py::scene_document_to_execution_config`
  mają warunki niepustych nodes. Frontend nie naprawia tej niespójności
  cichym fallbackiem; potrzebne są osobne regresje i zgodność round-trip/runtime.

Dowody dla aktualnych źródeł: TypeScript noEmit **PASS**, narrow ESLint
**PASS**, API hygiene **PASS**, architecture hygiene **PASS**, diff-check
**PASS**. Dodano regresje projekcji, pustej/nieznanej wersji, grup/makr,
duplikatów ID, singular/dual-form, odmowy flat write i obcego runtime ID.
Vitest **NIEWYKONANY**; browser gate nowych zmian **NOT VERIFIED**.
Nie zmieniano sceny ani procesu localhost:3197. Zmiany nie są częścią buildu 51.
Koordynator zwrócił running=true, accepting_jobs=true, executor_error=null;
job `5f67b9064e8f466dbc6689abe1d55ba6` nadal queued, bez terminalnego wyniku.
Pełny T00–T18 pozostaje nieukończony, w tym source preparation, zamknięcie
obwodu/kwalifikacja pól per-A, sprzężenie LLG/FFT, browser acceptance i integracja.

**Checkpoint T14/T15, 2026-10-11 — dedykowany etap i Inspector, weryfikacja źródeł:**

Po utrwaleniu kapsuły buildu 51 dodano semantyczny węzeł
`study.stage.antenna_field_solve` oraz dedykowany
`AntennaFieldSolveStageInspector`. Explorer zachowuje identyfikator wpisu
kolejki, oddzielny od referencji `payload.stage_id`. Router korzysta z jednego
istniejącego kontrolera Study i zasobu sceny; panel nie dodaje własnych
endpointów ani subskrypcji. `StudyStageAuthoringModel.ts::createStudyStageDraft`
rozpoznaje referencyjny solve, a `studyStageDraftToSceneStage` zachowuje jego
pełny payload bez dodawania parametrów Run/Relax. Definicja, obiekt źródłowy,
transport, uporządkowane porty, model, realizacja i deklarowane wyjścia są
pokazane osobno; brak lub niejednoznaczność definicji i rozbieżność portów
wywołują błąd informacyjny. Nie jest to certyfikat gotowości fizycznej.

Parametry mają jednego właściciela w inventory anteny. Referencji nie można
utworzyć jako pustego default stage ani zmienić jej rodzaju/ID tym edytorem.
`StudyInspectorPanel.tsx::studyInspectorPanelReducer` blokuje duplikowanie takiego
wpisu, a przycisk Duplicate jest wyłączony: zmiana samego ID szkicu nie
tworzyłaby drugiej definicji solve. Dla regionalnego wymuszenia etykiety
Explorer, Ribbon, komendy i Inspector zmieniono z „Antenna” na „Field Drive”.
Opis jawnie odróżnia zadane pole i FFT przebiegu czasowego od solve
przewodnictwa/Oersteda i przestrzennego widma wzbudzenia.

Dowody: TypeScript `--noEmit --incremental false` **PASS**, narrow ESLint
**PASS** (w tym nowe panele i zmienione etykiety), API hygiene **PASS**,
architecture hygiene **PASS**, `git diff --check` **PASS**. Dodano regresje
referencji, niedozwolonych portów, braku jawnej definicji, selekcji outer ID
i routingu. Vitest **NIEWYKONANY** zgodnie z zakazem kompilowania testów
jednostkowych. Browser gate nowego panelu **NOT VERIFIED**: tylko odczyt
istniejącej karty localhost:3197 wykazał pustą scenę oraz inną wersję backendu;
nie importowano fixture, nie restartowano i nie zmieniono modelu użytkownika.
Te nowe zmiany UI nie należą do kapsuły buildu 51.

Potwierdzona luka pipeline jest szersza niż sam builder węzła:
`sceneModelTreeAdapter.ts::sceneStudySnapshot` oraz
`StudyInspectorPanel.tsx::rawStudyStages` czytają tylko `study.stages`.
`StudyStageAuthoringModel.ts::buildStudyStagesMergePatch` zapisuje tę płaską
listę. Dlatego obsługa `study_pipeline.v1` przez enqueue nie dowodzi, że
Explorer/Inspector potrafią ją pokazać i edytować. Dalsza implementacja musi
wspólnie obsłużyć adapter, model szkicu, selekcję i revision-scoped zapis,
zachowując grupy, disabled nodes, payload, outer ID oraz pierwszeństwo
kanonicznego pipeline. Niedopuszczalne jest pozorne „spłaszczenie naprawcze”
ani zapis ignorowanej listy `stages` obok aktywnego pipeline. Ta bramka,
niemagnetyczne source preparation oraz rzeczywisty solve z UI pozostają otwarte.

Ostatni odczyt kolejki: build 51 `5f67b9064e8f466dbc6689abe1d55ba6`
pozostaje `queued`, exit code nieustalony. Poprawka katalogu standalone
quantities nadal wymaga jego terminalnego sukcesu oraz powtórzenia warm/cold
HTTP na dokładnej kapsule. Nie przypisujemy wyników buildu 50 nowszym źródłom.

**Checkpoint wykonania 2026-10-11 — build 50 i rzeczywiste V/J/H:**

Job `42545c4994424eeca8c2c9bd21ce365c` zakończył się `succeeded`, exit 0.
Managed launcher zweryfikował terminalny receipt, trusted documents, wymagane
artefakty oraz dokładną kapsułę źródeł przed uruchomieniem solvera.
Baza: `bbdf165066fc51a925e873f71f1f21ee943399e9`; source digest
`20af0bafd6f2e571a963125eea5b48a66875edb134d735617635b10506b2a821`;
native snapshot `1e7bbecf1f8b85966e2fc59091c9cdba6d0835ab9601982e92ba7123dc259a93`.
Backend, Python core, frontend produkcyjny i TypeScript zostały zbudowane.

Przypięty standalone RAM run `b411a99ff8874f3ca38f051ca5627b33`
wykonał solve bez magnetyka, Run i Relax. Porównanie eksportu: **PASS**.
Maksymalne błędy: V `1.1102230246251565e-16 V`, J
`4.440892098500626e-16 A/m²`, H `6.760249178929324e-9 A/m`, momenty
RT0 `2.220446049250313e-16 A`; suma strumieni każdego elementu `0 A`.
Zakres: 16 próbek V, 4 H, 12 środków J, 48 lokalnych próbek J,
108 ścian i 36 elementów RT0. Raport `export/V-J-H-comparison.json`
w run directory profilu `managed-antenna-ram-cpu` jest zachowany w storage.
Jest to jeden model z obcięciem na elektrodach, nie kwalifikacja zamkniętego
obwodu, per-A, całej fizyki, reusable LLG/FFT ani trwałego storage.

HTTP/cold run z probe `b48ce621f4d84ba690a2e71b2e8436c4`
w profilu `managed-antenna-http-ram-cpu`: solver exit 0, warm read-back
V/J/H **PASS**, `cold_archive_import=PASS`,
`native_canonical_bundle_redecoded=true`. Sprawdzono 12 rodzajów payloadów
display i odmowy pięciu nieprawidłowych owner guards. Nie jest to test
konkurencyjnego wyścigu, timeoutu, LLG ani authoringu UI. Scena użytkownika
na localhost:3197 nie została zmieniona.

Standalone HTTP run `65577b5774544e87ba1e69b1c7588092` zaliczył
solver i oba smokes V/J/H, ale **cała bramka FAIL przed cold import**.
Diagnostyczne powtórzenie `df572324891f490882ae3e2f1221c60d` wykazało
dokładny stan `m`: capability/solver `unknown`, materialization
`unmaterialized`, requestable/materializable `false`. Nie było dostępnego
magnetycznego payloadu; błędem jest nierozstrzygnięty katalog dla jawnie
niemagnetycznego planu. `router_v2/handlers/data/quantities.rs::annotate_runtime_quantity_state`
wracał przed użyciem kanonicznego unavailable resolvera przy capabilities=None.
Poprawka źródłowa kieruje standalone do tego resolvera dla całego katalogu,
pozostawiając `unknown` dla nieprzygotowanego workspace. Dwie regresje Rust
są napisane, **niekompilowane**. Poprawka powstała po buildzie 50 i wymaga
nowego buildu oraz rzeczywistej ponownej bramki standalone warm/cold.

Po buildzie 50 dodano również komendę
`antennaFieldSolveStudyCommand.ts::addAntennaFieldSolveStudyCommand`
i menu Explorer „Add Field Solve to Study”. Referencja jest revision-scoped,
bez kopiowania fizyki i bez certyfikowania readiness. Zachowuje pipeline v1,
grupy, disabled nodes i oddzielne outer ID / payload.stage_id; konflikty
odmawiają, wersje nieobsługiwane nie są zgadywane. Kontrola TypeScript
`--noEmit --incremental false`, targeted ESLint, API hygiene i diff-check:
**PASS** po uzupełnieniu typed fixture. Regresje Vitest napisane, niewykonane;
browser gate, stage Inspector i właściwe source preparation nadal otwarte.

Rzeczywisty start standalone ujawnił też brak dopuszczenia `--standalone`
w `scripts/just_storage_shell.sh`. Naprawiono oba dispatchery RAM/HTTP
bez wykonania dowolnego recipe text. Interpretowany test odtworzył odmowę
obu nowych recept przed poprawką; po poprawce **10 testów PASS**, w tym
odmowy composite commands, dodatkowych i powtórzonych flag. Te zmiany host
tools nie są przypisywane kapsule solvera 50.

**T14/T15 — luka pełnego przepływu UI, 2026-10-11, potwierdzona w kodzie:**
Aktualizacja po checkpointcie powyżej: enqueue jest teraz zaimplementowane
i ma zielony typecheck/lint; jego browser gate nadal otwarty. Build 51
`5f67b9064e8f466dbc6689abe1d55ba6` z poprawką katalogu i enqueue został
przyjęty jako `queued`, bez terminalnego wyniku. Source digest
`2d6d101f508a4a126a82385a3647ba7b51e3997a3fe746fa8ad965be556625ba`,
native snapshot `493d0d5964af176f69f36cf26cb4f258905f3746329efd3cc776268d3292199e`,
baza jak w buildzie 50. Kapsuła jawnie zawiera sześć nowych nieśledzonych
plików; późniejsze checkpointy nie są przypisywane temu buildowi.
Regresje host HTTP po poprawie diagnostyki: **68 testów PASS**.

Niezależny od buildu 50 przegląd wykazał, że obecnego UI nie można jeszcze
uznać za kwalifikowane „utwórz antenę → oblicz → pokaż V/J/H”.
`geometryLifecycleCommandContributions.ts` zapisuje inventory solve/port/current,
lecz nie etap `study.stages`. Ribbon „Antenna” wywołuje
`study.add-field-drive-stage` (regionalne pole sinc), nie solve przewodnictwa.
`StudyStageAuthoringModel.ts::stageKind` nie obsługuje `antenna_field_solve`;
importowany payload jest zachowany jako unsupported/read-only. Panel solution
czyta wyniki, ale nie dołącza solve do pipeline.

Druga luka jest w execution, nie tylko w przycisku:
`crates/fullmag-api/src/live_scene_preparation.rs::materialize_live_scene_preparation`
odmawia dla FEM każdego wariantu innego niż `BackendPlanIR::Fem`.
`studyRuntimeCommandContributions.ts::runtimeCommand` oraz
`livePreparationMaterialization.ts::materializeCurrentLivePreparation`
wymagają aktualnego shared-domain mesh także przed solve standalone.
Nie wolno obejść tego fake magnetykiem ani time-domain planem.
To dowód źródłowy; request preparation nie został jeszcze wykonany.

Wymagane dalsze kroki T14/T15, bez tworzenia drugiego endpointu/fizyki:
1. Dodać jawną, scoped komendę dołączenia istniejącej definicji solve do Study:
   referencyjny payload `kind=antenna_field_solve`, `stage_id`, `port_mode_ids`,
   zgodny z `script_builder.py::_export_study_pipeline_node`; kontrola
   ownership, revision, konfliktów i duplikatów, zachowanie innych etapów.
2. Dodać dedykowany Inspector/Explorer etapu i rozdzielić etykiety regionalnego
   wymuszenia od solve prądu/pola. Parametry fizyczne mają jednego właściciela
   w inventory anteny; etap nie tworzy ich kopii.
3. Zaprojektować i wdrożyć preparation receipt/readiness dla rzeczywistego
   standalone planu, oddzielnie od magnetycznej shared-domain mesh.
   Zachować requested/resolved execution, scene revision i integralność źródeł.
4. Rozdzielić readiness authoringu od kwalifikacji wyników basis w
   `shared/domain/physics/antennaStageValidation.ts::antennaStageValidationMessages`.
   Obecny wymóg gotowego ConservativeCurrentView daje błędny status dla
   jawnego current-source/lead-preparation requestu. Walidator nie steruje
   prepare/solve eligibility; jego poluzowanie samo nie uruchomi solvera.
5. Uzupełnić edytory faktycznego source/lead-preparation, prądów i geometrii
   doprowadzeń/powrotu. Domyślny microstrip ma jedynie terminale/materiały
   oraz umowny view ref; nie jest gotowym fizycznym źródłem.
6. Wykonać browser gate create/configure → prepare → solve → real V/J/H,
   ze stabilnością Inspectora i ownership. Import wcześniej kompletnego DSL
   nie zastępuje bramki authoringu nowej anteny w UI. Raw inspection nie
   kwalifikuje per-A, źródłowego FFT ani sprzężenia LLG.

**Standalone → jawnie zadany Run — 2026-10-11, authoring/export PASS:**
Regresja `test_standalone_then_run_captures_independent_authored_magnetic_state`
w `packages/fullmag-py/tests/test_antenna_standalone_authoring.py` sprawdza
oba integratory Heun/RK4. Pierwszy etap pozostaje niemagnetyczny, bez dynamics
i energii; drugi ma osobno zadany magnetyk, magnetyzację początkową +x,
`fix_dt=1e-15 s` i politykę tabeli mx/my/mz. Eksport zachowuje rozdzielone IR
oraz czas Run; nie dodaje fikcyjnego action Run ani domyślnego solved drive.
Tabela pozostaje `sampling.table_autosave`, nie polem w `sampling.outputs`.
Wynik pliku: **7 testów i 4 subtesty PASS**, bez uruchamiania solvera.
To dowód capture/eksportu, nie wykonania LLG, continuation magnetyzacji
ani sprzężenia pola anteny z Run. Test dopisano po utrwaleniu kapsuły buildu 50;
nie należy przypisywać go źródłom tego buildu. Native/runtime pozostają otwarte.
Łączna kontrola bieżących bramek RAM/HTTP/porównania i authoringu:
**136 testów i 4 subtesty PASS**. Walidator mapy źródeł noty 0950: exit 0.
Następnie dodano `test_standalone_then_relax_preserves_nonmagnetic_stage_snapshot`:
eksport późniejszego Relax z jawnie zadanym magnetykiem i m0=+y nie zmienia
wcześniejszego niemagnetycznego IR anteny ani nie aktywuje automatycznego drive.
Aktualny plik authoringu: **8 testów i 4 subtesty PASS**. Nie wykonano Relax;
nie jest to kwalifikacja runtime continuation ani reuse pola w LLG.

**Build 50 i baseline Run — 2026-10-11, obserwacja wykonania:**
Potwierdzono żywy, dokładnie przypisany jobowi kontener builda
`3e80f8dfa4d286efd70cc7c3bf54e22733a382ba04e3c7cfbc1f58d39ce86cb0`.
Początkowo działał tylko trusted Python przygotowujący/weryfikujący źródła;
nie był to jeszcze dowód kompilacji. Następny odczyt procesów potwierdził
make/Cargo/rustc/CMake oraz zapis `artifacts/logs/native-build.*.log`.
Kolejny odczyt logu potwierdził dwa zakończone wywołania release
(`Finished ... in 11m 35s` i `11m 31s`) oraz rozpoczęcie budowy
`fullmag-py-core` do certyfikacji siatek. Nie jest to ukończenie całego joba:
pozostają wymagane moduł Pythona, frontend i finalny receipt/hash pakietu.
Stan nadal `running`, bez dowodu ukończenia pakietu.
Ograniczone timeouty obserwatora nie anulowały
wykonania i nie spowodowały restartu.

Znana regresja `test_build_entrypoint_run_pipeline_contains_only_run_owned_controls`
została odtworzona zarówno na WIP, jak i na **dokładnych wersjonowanych
źródłach Pythona HEAD `bbdf165066fc51a925e873f71f1f21ee943399e9`**.
Baseline odczytał wszystkie importy fullmag przez izolowany import hook
z `git show` tego SHA, odmawiając brakujących modułów, bez checkout/reset
i bez edycji testu. Obie próby: 1 FAIL, identyczny nadmiar integrator/fixed_timestep,
sampling oraz pustych pól relaxation w payloadzie Run. To potwierdzona
wcześniejsza rozbieżność test/eksport, nie regresja obecnego standalone.
Nie rozstrzygnięto jeszcze docelowego kontraktu payloadu i nie wyciszono testu;
pełny suite nadal nie jest GREEN. Natywna continuation do Run pozostaje otwarta.

**Standalone warm/cold HTTP — 2026-10-11, bramka przygotowana / runtime otwarty:**
Dodano `just run-managed-antenna-standalone-cold-http-ram` i jawny wariant
`--standalone` w `scripts/run_managed_antenna_http_ram.py`. Komenda, manifest
narzędzi, wejście i receipt muszą wskazywać ten sam wariant; generated script
zachowuje osobny digest. `check_standalone_read_model` odczytuje kanoniczne
zasoby v2: pusty katalog pól przestrzennych, unsupported/not-requestable m,
H_eff i H_demag oraz brak read-modelu magnetycznej siatki. Kontrola powtarza
się po cold import i wymaga niezmienionego ownera/revisions podczas odczytów.
Nie ukrywa całego globalnego katalogu definicji quantities; sprawdza jego
runtime capability/materialization zamiast błędnie wymagać pustego katalogu.

Regresje HTTP/cold-import: **94 testy PASS**, w tym odmowy starego carrieru,
dostępnej quantity, zmienionego ownera, wejścia/manifestu i brakującego dowodu.
Helper transformacji znajduje się w zahashowanym manifestcie host tools,
nie jest przypisywany kapsule solvera. Izolacja RAM i kwalifikacje false
pozostają bez zmian. Bramka dopiero przygotowana: nie uruchomiono jej na
buildzie 50, który nadal jest `running`. Nie potwierdzono także przejścia
z aktywnej magnetycznej sesji do standalone, continuation do Run ani UI.

**Odbiór standalone V/J/H — 2026-10-11, interpretowany PASS / native otwarty:**
Usunięto lukę w `scripts/compare_managed_antenna_ram.py::compare`: porównanie
wybiera teraz rzeczywiście wykonany wariant skryptu z receiptu, zamiast zawsze
odtwarzać oryginalny magnetic probe. `reconstruct_inputs` używa izolowanego
publicznego DSL z dokładnej kapsuły i dla standalone wymaga pustych
magnets/energy oraz dokładnego study bez dynamics. Rozróżnia authored asset
`probe` od historycznego magnetycznego `probe_geom`; nie zmienia siatki ani
pinów wzorca. Nieznany wariant i magnetic probe podany jako standalone odmawiają.

`scripts/test_compare_managed_antenna_ram.py::test_actual_standalone_input_preserves_physical_oracle_pin`
potwierdził rzeczywiste odtworzenie wejścia standalone z tym samym digestem
`a7f2c4f5326cfe5fca253ba99e4e7d47f8b6162d765211abecf68aecaffabb74`
co bazowy model. Regresje porównywarki, RT0 i skojarzenia obserwabli:
**99 testów PASS**. Raport zachowuje wariant i informację o niemagnetycznym
odtworzonym wejściu; nadal jawnie nie jest dumpem wykonanego native IR ani
kwalifikacją LLG/FFT, pełnego obwodu czy trwałego storage. Build 50 przeszedł
z `queued` do `running`; ograniczone oczekiwanie nie dało jeszcze stanu
terminalnego. Nie wykonano nowego solve ani porównania rzeczywistego
eksportu standalone. Rzeczywisty odbiór pozostaje kolejną bramką.

**Bramka standalone RAM — 2026-10-11, testy interpretowane PASS / native otwarty:**
Dodano receptę `just run-managed-antenna-standalone-ram` z tymi samymi czterema
pinami buildu co istniejąca trasa RAM. `scripts/antenna_standalone_fixture.py::standalone_source`
tworzy osobny skrypt z przypiętego oryginału: zmienia probe na niemagnetyczny
`geometry_object` i usuwa dokładnie Ms/Aex/alpha/m. Oryginał, doprowadzenia,
port, prądy i siatki pozostają niezmienione; nie powstaje nowy model fizyczny
zamknięcia obwodu. Transformacja odmawia nieoczekiwanego konstruktora,
niekompletnego/powtórzonego stanu probe i braku etapu solve.

`scripts/run_managed_antenna_ram.py::start` zapisuje wariant i SHA wygenerowanego
wejścia obok trzech oryginalnych pinów. `observe` ponownie wyprowadza to wejście,
sprawdza jego rzeczywiste bajty, receipt i dokładną komendę kontenera przed
odczytem wyniku. Nie osłabiono kontroli pakietu/kapsuły ani izolacji tmpfs;
nieznany wariant lub zamiana standalone na magnetic_probe powodują odmowę.
Stare receipt bez wariantu zachowują kontrakt oryginalnego przykładu.

Regresje czterech modułów RAM/HTTP/cold-import: **122 testy + 11 podtestów PASS**.
`scripts/test_run_managed_antenna_ram.py::test_generated_standalone_lowers_without_magnetic_state`
sprawdza prawdziwe lowering Pythona: magnets/energy puste, study bez dynamics,
exact current/port/stage zgodne z oryginałem. Osobne testy sprawdzają odmowę
zmienionych bajtów, digestów i wariantu. To testy interpretowane, bez native
i bez kwalifikacji naukowej. Nowy launcher jest przyrostem **po capture builda 50**;
nie przypisujemy go tej kapsule. Użyje osobno zahashowanego wejścia i tylko
zweryfikowanego terminalnego pakietu; nie wymaga kolejnej kompilacji tego samego
kodu solvera. Build 50 nadal oczekuje. Po jego sukcesie trzeba uruchomić tę
receptę, odebrać V/J/H i niezależnie porównać wynik; exit 0 pozostaje tylko
`solver_succeeded_comparison_pending`. Standalone HTTP, czyszczenie sesji,
continuation do Run oraz rzeczywiste UI nadal wymagają osobnych dowodów.

**Build standalone 50 — 2026-10-11, queued / runtime otwarty:**
Zamrożony snapshot zgłoszono do zdrowej wspólnej kolejki po zakończeniu
wszystkich zapisów agentów. Job `42545c4994424eeca8c2c9bd21ce365c`,
profil `fem-cpu-release`, base `bbdf165066fc51a925e873f71f1f21ee943399e9`,
source digest `20af0bafd6f2e571a963125eea5b48a66875edb134d735617635b10506b2a821`,
native snapshot `1e7bbecf1f8b85966e2fc59091c9cdba6d0835ab9601982e92ba7123dc259a93`,
capture `c342ae789e6b4e0ba1ecc7cef9f65fa8`. Stan przy przyjęciu: `queued`.
Jawnie włączono oba nowe moduły Rust publikacji/importu oraz regression
`test_antenna_standalone_authoring.py`. Build nie kompiluje unit tests.

Read-only review znalazł błąd continuation: inspection bez poprzedniego
magnetycznego etapu mógł zamienić `None` w `Some([])` i zepsuć authored
initial state kolejnego Run. Poprawka pomija cały replacement continuation
dla `AntennaExternalLeadInspection`; semantyka ChangeDevice pozostaje.
Stan/certificate rzeczywistej wcześniejszej magnetyzacji jest tylko handoff,
nie nowym wynikiem inspection. Test runtime tej granicy pozostaje otwarty.
Nowy build obejmuje także czyszczenie starych magnetic carriers w API oraz
poprawkę E0369. Nie używaj pinów builda 47 do odbioru tego przyrostu.
Po succeeded/0 i pełnej weryfikacji receiptu: rzeczywisty warm/cold V/J/H,
standalone bez m/Ms/LLG oraz odmowy Run/Relax i błędnych owner/digest.
Nie restartowano workspace na 3197 ani obcych kontenerów.

**Checkpoint standalone — 2026-10-11, GREEN authoring / WIP native:**
Ten wpis zastępuje stan RED opisany niżej. Dodano Python
`AntennaFieldSolve` i Rust `StudyIR::AntennaFieldSolve` bez dynamics,
dedykowany niemagnetyczny plan inspection, scoped walidację oraz eksport
sceny bez sztucznego magnetyka. Run/Relax nadal wymagają magnetyka.
Przypięty przykład i jego fizyczne wejście pozostają niezmienione.
Interpretowane regresje Pythona: **116 testów + 72 podtesty PASS**,
w tym standalone lowering i dwa eksporty/ponowne importy zachowujące
exact current/source/port/stage IDs. Osobny szerszy test starego pipeline
Run (`test_build_entrypoint_run_pipeline_contains_only_run_owned_controls`)
pozostaje czerwony; nie zaliczono całego suite ani nie wyciszono tego błędu.
Walidator noty 0950: PASS; 33 interpretowane testy kontraktu dokumentacji: PASS.
Testy Rust napisano, ale nie kompilowano zgodnie z ograniczeniem hosta.
Nie jest to dowód natywnego solve ani wizualizacji rzeczywistych pól.

Build 47 zakończył się terminalnie **failed / exit 2**. Kompilator wykazał
E0369 w `live_workspace.rs::publish_terminal_and_wait`: operator `>=`
na `FieldSourcePrecedence` bez `PartialOrd`. Poprawka wykorzystuje istniejący
kanoniczny `cmp` (scientific step/revision/time, potem materialization time),
zamiast dodawać porządek pochodny. Kolejna kapsuła będzie zawierać tę poprawkę
oraz standalone. Warm/cold HTTP pozostaje niewykonany do czasu poprawnego
terminalnego buildu. Nie restartowano runnera ani workspace użytkownika.
Weryfikacja sesji musi objąć usunięcie starych magnetic mesh/fields przy
przejściu do standalone; rzeczywiste V/J/H pozostają zasobami inspection,
nie katalogiem magnetycznym i nie qualified per-ampere basis.

**Historyczny checkpoint standalone — 2026-10-11, reprodukcja RED:**
WIP `packages/fullmag-py/tests/test_antenna_standalone_authoring.py`
zachowuje oryginalny input przewodnika, doprowadzeń, portu i siatki próbkowania.
Transformacja AST zmienia wyłącznie konstruktor probe na `geometry_object`
typu `geometry` oraz usuwa dokładnie Ms/Aex/alpha/m; nie zmienia przypiętego
przykładu używanego przez managed RAM gate. Test wymaga pustych magnets/energy,
braku dynamics oraz tej samej definicji current/port/stage. Obecny wynik:
**1 failed, 2 passed, 2 podtesty passed**. RED jest rzeczywistą odmową
`world.py::_build_problem` (`No magnets defined`) przy
`StudyStagesBuilder.add_antenna_field_solve`, nie nieudanym solve.
Niezmieniony przykład magnetyczny i odmowy Run/Relax bez magnetyka przeszły.
Pierwsza negatywna próba Relax miała niekompletny timestep; uzupełniono
`dt=1e-13`, aby sprawdzać odmowę braku magnetyka, nie błąd konfiguracji.
Nie wyciszono czerwonej bramki i nie kompilowano unit tests.

Read-only przegląd ustalił konieczne granice: Python `world.py::_build_problem`
i `Problem.__post_init__`, Rust `ProblemIR::validate`/`StudyIR`, dispatch
plannera, dedicated carrier sesji oraz script export. Native
`antenna_external_lead_solution/execution.rs::execute_antenna_external_lead_inspection`
nie potrzebuje magnetyzacji. Nie wolno usuwać wymogu magnetyka globalnie ani
uznać obecnego Zero-Zeeman/Heun carrieru za rozwiązanie standalone.
Następna implementacja wymaga jawnej rodziny antenowego studium bez dynamics,
dedykowanego planu/nośnika niemagnetycznego i snapshotu bez fikcyjnego m;
zwykły LLG/Relax nadal musi odmówić takiego wejścia. Test jest lokalnym WIP,
nie ukończonym fragmentem ani zmianą produkcyjnego Python/IR.

Build 47 ma obecnie queue state `running`; obserwacja nie wykazała jeszcze
runrootu, worker logu ani osobnego kontenera joba. Koordynator jest aktywny.
To stan przygotowania zadania, nie dowód kompilacji. Nie restartowano procesu,
nie powtórzono submit ani nie uruchomiono warm/cold gate bez terminalnego receipt.

**Checkpoint T15 — 2026-10-11, pełny cykl edycji gałęzi portu:**
Rozszerzono kontrolowany browser fixture o jawnie istniejące dodatkowe
referencje terminali, bez tworzenia ich przez edytor. Poprawne dodanie trzeciej
gałęzi z wagami `1, -0.5, -0.5`, jej zmiana ID po ACK oraz usunięcie z powrotem
do dwóch gałęzi przeszły przez rzeczywisty klient transakcji i panel produkcyjny.
Payload zachował current transports i drugi port; kolejne zapisy użyły dokładnie
rewizji 1, 2 i 3. Osobna próba z serwerową zmianą ID gałęzi potwierdziła, że
jawny Rebase nie wskrzesza starej gałęzi: szkic pozostaje, Apply jest zablokowane,
a Revert przyjmuje aktualny identyfikator. Nie zmieniano kodu edytora.

`verify-antenna-port-editor-browser`: **11 scenariuszy PASS**, dziewięć workflow,
4–11 żądań i 14–36 renderów; zachowane wcześniejsze kontrole stabilności oraz
idle, brak błędów strony/konsoli. Receipt i raport:
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-control-room-browser-fixture/antenna-port-editor-browser/b4a2861a820344d8adee70272159bc60/`.
TypeScript rozszerzonego fixture: **PASS**, receipt
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-control-room-source-check/production-source/7f44c01208c5447bba6bb5b94bf63a47/receipt.json`.
Końcowy ESLint: **PASS**, receipt `lint/4a295223dc824c638e36d9e57d4e18f0`
w tym samym profilu source-check. Nie zmieniono produkcyjnych endpointów,
resource hooks ani edytora; wcześniejsza zielona kontrola API tych źródeł
pozostaje ważna. Oczekiwanie `runner-wait` na konkretny build 47 zakończyło
się timeoutem obserwacji, nadal `queued`; nie jest to awaria ani zgoda na restart.
Jest to authoring z kontrolowanym HTTP, nie rzeczywisty backend ani
kwalifikacja dwóch fizycznych ścieżek powrotnych. Nie kompilowano unit tests.
Build 47 i bieżący kod natywny pozostają przypięte do poprzedniej kapsuły;
rozszerzenie fixture nie zmienia tamtych źródeł.

**Kontynuacja odbioru — 2026-10-11, build 47 queued:**
Zweryfikowany fragment edytora portu zapisano w commicie
`5c573ac4fcd2b9db13a7cf954fc06e82274055f1`.
Po potwierdzeniu zdrowia runnera i osobnego aktywnego zadania nr 46 zgłoszono
nową kapsułę przez zaufany klient tej samej kolejki, bez zatrzymywania kontenerów:
job `f11d42f1ab354cb38870baba73c652f3`, profil `fem-cpu-release`,
base `5c573ac4fcd2b9db13a7cf954fc06e82274055f1`, source digest
`fbd49d5fbb22cafb7d9a47ed33e2d3daad5720dd16723ceea8060b35445e5ace`,
native snapshot `8453732232feabeefc7218e76e6a3ed2c909299bb036d408f16e4ec62215fe55`,
capture `d59822fcd7204527b7656adc34fd96b8`. Stan przy zgłoszeniu: `queued`.
Kapsuła jawnie zawiera oba nowe moduły Rust; siedem zmian natywnych pozostaje
WIP. Build 45 zachowuje terminalne `blocked`; nie zmieniano jego rekordu.
To nie sukces kompilacji ani odbioru naukowego. Po terminalnym sukcesie 47
należy wykonać `run-managed-antenna-cold-http-ram` z dokładnie powyższymi
czterema pinami, sprawdzić warm/cold metadata/display/binary V/J/H i negatywne
próby importu. Brak poprawnego receipt blokuje ten run, nie upoważnia do fallbacku.

**Checkpoint T15 — 2026-10-11, edycja istniejącego portu; build 45 blocked:**
Ten wpis aktualizuje stan wcześniejszych checkpointów: edytor istniejącego
portu jest zaimplementowany, a build nr 45 nie jest już `queued`, lecz `blocked`.
Poprzedni fragment diagnostyki zapisano w commicie
`0198274fbbde810ba929e397787b9b9670de16fa`.

`AntennaPortEditor.tsx::AntennaPortEditor` obsługuje transport, identyfikatory
gałęzi, pary inlet/outlet i jawne signed weights. Umożliwia dodanie pustej
gałęzi, usunięcie gałęzi, Apply, Revert, Refresh i jawny Rebase.
Nie tworzy terminali, drive ani fizycznego domknięcia obwodu; nie tworzy
ani nie usuwa samego portu. Nie zmienia source, schema ani normalization.
`AntennaPortEditorModel.ts::buildAntennaPortTransaction` korzysta ze wspólnej
scene-aware walidacji, wymaga dokładnej base revision i emituje wyłącznie
kanoniczny merge patch `antenna_port_modes`, zachowując pozostałe porty oraz
nieznane atrybuty. Nie normalizuje wag i nie zamienia pustego inputu na zero.
ACK waliduje `committedAntennaPortScene` przed publikacją historii i cache;
`acknowledgeAntennaPortDraft` zachowuje nowszy szkic oraz lokalne klucze wierszy.
Owner token, session request scope i history generation odcinają stare ACK.
HTTP 409 i nieprawidłowy ACK nie wywołują automatycznego retry.

`just verify-antenna-port-editor-browser`: **9 scenariuszy PASS** na porcie
3264. Kontrolowany HTTP używa rzeczywistego klienta, resource hooks, historii
i komponentu produkcyjnego. Zweryfikowano nieprawidłowe dane, opóźniony ACK,
nowszy szkic, konflikt rewizji, HTTP 409, błędną normalization/scene_revision,
reset historii oraz przejście sesji A→B→A. W siedmiu workflow odnotowano
5–11 żądań oraz 14–34 renderów; przez 700 ms idle nie było nowych żądań
ani renderów. DOM root, input, fokus, scroll, disabled i opacity pozostają
stabilne; zero aktywnych animacji opacity oraz błędów strony/konsoli.
Raport i trzy zrzuty:
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-control-room-browser-fixture/antenna-port-editor-browser/d5c92062702c42bdbd780cdd50a9bdfb/`.
Pierwsza próba `2bd95b54ad2b49fb8af740aed908a222` pozostała failed:
niejednoznaczny selektor testu zastąpiono dokładnym selektorem textbox;
nie zmieniano dostępności komponentu ani nie zaliczono nieudanej próby.

Regresja dotychczasowego inspektora po integracji edytora: **PASS**, receipt
`antenna-port-diagnostics-browser/588bec62c7df443fb7525fe6d3e84f7c`
w tym samym katalogu profilu browser. TypeScript źródeł produkcyjnych
`production-source/e2abd660a35841f982b30223f3691587`, ESLint
`lint/96003b1f81f9484d9ae99e5307b077c5` oraz API hygiene
`api-hygiene/7ffc2c1d7e5547e793eeb57ad99b651a`: **PASS**, receipts pod
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-control-room-source-check/`.
Interpretowany dispatcher: **8 PASS + 10 podtestów**. Niezależne review:
Required dotyczący kontroli scene_revision poprawiono; finalnie brak
Required/Blocker. Zapisane testy Vitest nie były kompilowane ani uruchamiane.

Build 45 `fc763cf735b74842bc07fbe92915b6e0` zakończył się stanem
`blocked` przed kompilacją. Zdrowy koordynator raportował
`Existing Fullmag container must finish before queued build`; brak runrootu
i logu kompilacji nie jest dowodem wykonania solvera. Nie zatrzymywano cudzych
kontenerów ani nie restartowano runnera. Kolejnym krokiem jest bezpieczne
rozstrzygnięcie blokady kolejki, managed build z przypiętych źródeł oraz
real warm/cold V/J/H readback. Ten checkpoint nie kwalifikuje backendu,
pełnego workspace/WebGL, fizycznego obwodu, per-A, LLG ani FFT.
Workspace 3197 i scena użytkownika pozostają bez zmian; T00–T18 są otwarte.

**Checkpoint T15 — 2026-10-11, diagnostyka referencji portu w UI:**
`antennaPortValidation.ts::antennaPortValidationMessages` otrzymuje aktualny
`SceneResource`; wspólną walidację wykorzystują Explorer i `AntennaPortPanel`.
Sprawdza jednoznaczny transport static one-way OhmicPoisson, istniejący source,
przynależność terminali do domeny, parę na jednym obiekcie oraz dodatnią gałąź
na source. Zachowuje kanoniczną kolejność namespace: current-source observations
→ lead-preparation extensions → electrical boundaries. Obecny nieprawidłowy
source nie może zostać zastąpiony poprawnymi historycznymi boundaries.
Source/preparation wymaga dokładnie jednego jawnego drive dla portu.
Poprawne referencje są opisane jako `valid authoring references` / `authoring`,
nie jako kwalifikacja domknięcia prądu, siatki ani pola.

Wykonano `verify-antenna-port-diagnostics-browser` na izolowanym porcie 3263:
**8 wariantów + stabilność PASS**, 11 żądań GET, 30 renderów, zachowany DOM root,
fokus i lokalny szkic; zero aktywnych animacji opacity, błędów strony/konsoli
oraz dodatkowych żądań/renderów przez 700 ms po ustaleniu stanu.
Raport i dwa wizualnie sprawdzone zrzuty są w
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-control-room-browser-fixture/antenna-port-diagnostics-browser/cc29b41b715241d8b3a1766248a9cc4f/`.
Pierwsza próba fixture nie zadeklarowała current session, druga miała błędnie
zakotwiczony selektor względny; obie zostały zachowane jako failed i poprawione,
nie zaliczone. TypeScript finalnych źródeł, ESLint całego frontendu
i API hygiene: **PASS**. Receipts source-check:
`production-source/42ef3e127fe54fc297de8f6c4924aff4`,
`lint/c36f0b24a72d4ac9ba7477116e6d0825`,
`api-hygiene/d187219093ad41aa8d9ce14baa4a8960`
pod `storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-control-room-source-check/`.
Interpretowane regresje dispatchera: **7 PASS + 10 podtestów**.
Niezależny source review: brak Required/Blocker. Testy Vitest zapisano, lecz
nie kompilowano ani nie uruchamiano zgodnie z zakazem budowania unit tests.

To kontrolowany HTTP fixture rzeczywistych komponentów, nie odbiór backendu,
WebGL ani fizyki. Edytor portu nadal wymaga implementacji; nie dodano mutacji,
nie zmieniono sceny ani workspace 3197. Build 45 nadal `queued`; terminalny ACK,
canonical V/J/H readback i cold import oraz pełne T00–T18 pozostają otwarte.

**Checkpoint narzędzi odbioru — 2026-10-11, wykonanie natywne nadal otwarte:**
Dodano jawną receptę `run-managed-antenna-cold-http-ram` i narzędzie
`scripts/antenna_inspection_cold_import_check.py::verify_cold_import`.
Po rzeczywistym solve oraz warm HTTP eksportuje oryginalne FMS przez API,
sprawdza istniejące refs i komplet payloadów, odrzucenie uciętego archiwum
bez zmiany sesji, ukrywa pierwotny `/ram/result.zarr`, importuje niezmienione
archiwum i porównuje metadane naukowe oraz SHA-256 wszystkich 12 payloadów.
Sprawdza odcięcie starego request scope i przywrócenie oryginalnego katalogu.
Rewizja sesji/etapu nie jest digestem naukowym: po imporcie może się zmienić;
powiązanie metadata/display wewnątrz każdego odczytu nadal jest wymagane.
Observer wymaga zachowanego raportu, tożsamości FMS oraz jawnych dowodów;
błąd cold importu nie może pozostawić sukcesu warm gate.
Weryfikacja interpretowana: **81 PASS + 10 podtestów**, następnie osobna
nowa regresja importu wyłącznie przypiętych narzędzi w Pythonie `-I`: **1 PASS**.
Nie kompilowano testów Rust. Nowe narzędzia są przypinane osobno i nie należą
do wcześniej zgłoszonej kapsuły nr 45. Build 45 pozostaje `queued`;
odczyt zdrowia runnera potwierdził inne aktywne zadanie nr 42. Lista zadań
zwróciła HTTP 500; nie restartowano koordynatora ani cudzych prac.
Warm/cold runtime, browser/WebGL, kwalifikacja fizyki i trwałego zapisu,
per-A/LLG/FFT oraz pełne T00–T18 pozostają **NOT VERIFIED / otwarte**.
Workspace 3197 i scena użytkownika bez zmian.

**Snapshot do odbioru — build nr 45, queued:**
Po zakończeniu review i zamrożeniu wszystkich writerów zgłoszono
`fc763cf735b74842bc07fbe92915b6e0` z base
`47323b145006b8f9148bbf0113fef910bcc99723`, source digest
`03d5128036b8ef790435045ffe48d3530970b14168a0268921b6860ab4a22b77`,
native snapshot `71a01b577cc4bab9ed6ace95f2f1d1a4114b7bc33bf234de73a711a5186ee181`.
Kapsuła obejmuje terminalny ACK, guard bez zmiany connectivity przy odmowie
oraz cold-import normalization, z dwoma jawnie dołączonymi nowymi modułami.
To snapshot WIP, nie clean commit ani sukces buildu. Następny krok:
terminalny receipt i walidacja pakietu → `run-managed-antenna-http-ram`
z dokładnie tymi pinami → rzeczywisty cold import → browser/UI.
Zweryfikowane narzędzie negatywnej bramki zapisano w powyższym base commicie;
same poprawki Rust pozostają WIP do odbioru managed. Workspace 3197 bez zmian.

**Cold import — kod po review, odbiór runtime otwarty:**
`session_persistence.rs::import_session_commit_with_context` normalizuje
istniejące refs inspekcji przed zmianą katalogu artefaktów i publikacją importu.
`session_persistence_antenna_import.rs::normalize_registered_refs` zachowuje
autorstwo etapu, wymaga dokładnego runtime stage/run namespace, starego rootu
oraz faktycznej obecności rekordu w `FmsStagedPreflight::contains_document`.
Przepisuje ref na względny suffix; nigdy nie odczytuje starego hosta i nie
odtwarza refs przez skanowanie archiwum. Plan całej zamiany jest walidowany
przed mutacją. Obce rooty, traversal, aliasy, duplikaty i brakujące rekordy
kończą import błędem przed publikacją. Compact/bez artefaktów i nieznane
etykiety nie są przepisywane. Payloady nadal waliduje canonical reader.
Niezależny source review nie wykazał Required/Blocker; pięć regresji Rust
zapisano, ale nie uruchomiono ani nie skompilowano. Wymagane pozostają managed
build oraz real warm → archive → cold import z niedostępnym starym rootem,
następnie metadata/display/binary V/J/H i negatywne próby archiwum.

**Przyrost terminalnej publikacji — kod po review, runtime NOT VERIFIED:**
Dodano `live_workspace.rs::LocalLiveWorkspace::publish_terminal_and_wait`
oraz `terminal_publication.rs::TerminalPublication`: niezmienny snapshot,
monotoniczny numer, ograniczone oczekiwanie i dokładny ACK przez istniejący
serialny worker. Orchestrator czeka przed zakończeniem lease; błąd zachowuje
wyniki i scratch. API off pozostaje no-op. Worker najpierw odprowadza próbki
skalarne i istniejącą transakcję generacji pól, potem końcowe metadane oraz
diagnostykę. Nie wymusza nielegalnego zastąpienia pól ani powtórzenia generacji.
Prywatny istniejący RPC snapshot przyjmuje precondition owner w nagłówku
`x-fullmag-terminal-owner`. `main.rs::validate_terminal_snapshot_owner`
sprawdza session/run oraz licznik i instancję request scope pod blokadą
przejścia, przed apply. Sprawdzenie GET przed/po POST nie zastępuje tej kontroli.
Pierwszy frame może wymagać rzeczywiście pustego workspace; po wcześniejszej
próbie publikacji worker nie odtwarza znikniętej sesji. Bootstrap nie publikuje
najnowszej próbki przed starszymi. Publiczne OpenAPI i frontend nie zmieniają się.
Niezależny source review: wcześniejsze Required poprawione; diff check PASS.
Regresje Rust zapisano, ale **nie kompilowano ani nie uruchamiano** zgodnie
z obowiązującym zakazem. Managed build i rzeczywiste V/J/H HTTP smokes muszą
dopiero potwierdzić poprawkę. Nie zmienia to negatywnego wyniku buildu nr 41
w bramie HTTP ani pozostałych otwartych bramek fizycznych T00–T18.
Zgłoszono snapshot buildu nr 44: `17744d15abc742eabb56dfee08cf04a6`,
base `b66fa562e1e9e32021517b9ffe352ca69f1575d8`, source digest
`b8cf3d4fe776eca4bf4cb1f5a1f9fea2e2b9d2d2fc123ba975af4613683e187a`,
native snapshot `9eaf08f0fb60923796f9fbd309ce93f2b11dc5f99a584254ab041cfb754a9f16`.
Build pozostał w kolejce i został anulowany przed rozpoczęciem kompilacji
po wykryciu dodatkowego skutku ubocznego odrzucenia ownera. Stan terminalny
`cancelled` potwierdzono; kapsuła pozostaje zachowana. Następny snapshot musi
zawierać poprawkę: tylko typowane błędy admission `terminal_snapshot_owner_stale`
i `terminal_snapshot_owner_busy` nie oznaczają bieżącej sesji jako degraded.
Pozostałe błędy apply zachowują dotychczasowe zachowanie.
Osobno przypinane narzędzie `run_managed_antenna_http_ram.py::reject_stale_terminal_owners`
sprawdza po rzeczywistym read-back odrzucenie złego runu, epoki, instancji API,
bootstrapu bez wymaganej jawnej koperty session/run i nieznanego pola guardu.
Nie wstrzykuje pól naukowych ani refs; wymaga rzeczywistego kodu i komunikatu
błędu oraz niezmienności właściciela, rewizji zasobów i lifecycle.
Regresje interpretowane helpera: **41 PASS**. To nie jest runtime dowód
wyścigu współbieżnego, timeoutu ani bootstrapu poprawnej koperty do niepustej
sesji; te kwalifikacje pozostają otwarte. Regresję odrzucenia ownera bez zmiany
connectivity zapisano także w Rust, lecz nie uruchomiono.
Narzędzie uzupełniono po capture i nie przypisuje się go kapsule buildu nr 44.

**Brama rzeczywistego HTTP — wynik negatywny, 2026-10-11:**
Dodano kontrolowaną receptę `just run-managed-antenna-http-ram` i obserwator,
używające istniejącego buildu nr 41, osobno przypiętych SHA narzędzi oraz
sesji tmpfs. Kontener nie publikuje portów hosta, ma sieć `none`, API działa
wyłącznie na jego loopback; nie zmieniono workspace 3197.
Po naprawie dokładnego dispatchera `just` i zgodności SHA z Pythonem kontenera
próby `22b7919f7700414d90ba0919e459fe64` oraz
`2089836736454d189938c8140dcfb333` wykonały solver z exit 0, ale nie przeszły
bramy HTTP. Ostatnia odpowiedź endpointu etapu: HTTP 404,
`missing_antenna_inspection`, `stage has no registered inspection result`.
API odbierało aktualizacje sesji. Odczyt z uwzględnieniem ukrytych katalogów
potwierdził kompletną kopię artefaktów V/J/H, bundle, manifest v2 i record
etapu w `result.zarr/artifacts/antenna`; digest manifestu odpowiada udanemu
runowi bez API (`4cd5b183…`). Początkowy odczyt bez `-Force` pominął ukryte
katalogi; nie jest to utrata danych ani błąd cleanup.
Source review wykazał brak końcowego flush/ACK asynchronicznego publishera
przed powrotem z orchestratora. To kandydat na przyczynę braku końcowego ref;
poprawka wymaga reprodukcji i bramy runtime, nie samego przeglądu źródeł.
Raport błędu i logi pozostają w storage profilu `managed-antenna-http-ram-cpu`.
Canonical Rust re-decode przez API, prawdziwe HTTP smokes i cold import
pozostają **NOT VERIFIED**. Nie rejestrować sztucznych refs, nie zastępować
próby fixture-em API ani nie wyłączać guardów SessionStore.
Regresje helpera/launchera: **38 PASS + 7 subtestów**; wcześniejszy łączny
pakiet readerów, transportu i helpera: **181 PASS + 49 subtestów**.
Komparator V/J/H poniżej dotyczy odrębnego, zakończonego sukcesem runu bez API.

**Kontrakt przyrostu — terminalny ACK publikacji (kod powyżej, odbiór otwarty):**
`crates/fullmag-cli/src/live_workspace.rs::CurrentLivePublisher` uruchamia
worker bez zachowania `JoinHandle`; `request_publish` jedynie kolejkuje wake.
`current_live_publisher_loop` ma drain po zamknięciu kanału, ale orchestrator
nie czeka na jego zakończenie przed wyjściem procesu.
Implementacja musi przesłać niezmienny końcowy snapshot po ostatnim update/log
przez ten sam serialny worker i przydzielić mu monotoniczny numer publikacji.
ACK powinien potwierdzać dokładny numer, session_id i run_id dopiero po
pełnym sukcesie istniejącego cyklu HTTP, nie po samym session-frame.
Nie wystarczy obserwacja `pending=false`/`sending=false` ani arbitralny sleep.
Wyłączone API pozostaje jawnym no-op; deadline, zerwany worker, zmiana ownera
i błąd HTTP kończą próbę błędem bez usuwania wyników naukowych.
Regresje: brak ACK starszego preview, zachowanie terminalnych artifact_refs,
serializacja z trwającym publish, odmowa obcego ownera, timeout i API off.
Odbiór: nowy managed build, ta sama brama rzeczywistego HTTP i oba smokes
V/J/H; dopiero wtedy canonical API re-decode może uzyskać PASS.

**Rzeczywisty odbiór V/J/H — 2026-10-11:**
Build nr 41 `1128d9f468ee4b0981387a8cdf448451` zakończył się
`succeeded`, exit 0, dla commita `62d9618b2eebec639e52eeea842ffde19525a4bd`.
Pełny validator launchera sprawdził pakiet, trusted documents i kapsułę.
Zatwierdzony `just run-managed-antenna-ram` wykonał przypięty model na
FEM CPU/double: run `92cdc1e909c242c58c81f1aa495df435`, solver exit 0,
startup identity i izolacja PASS. Rzeczywisty eksport v2 zawiera V/J/H.
Independent fixed-fixture comparison PASS: maksymalny błąd V
`1.1102230246251565e-16 V`, J `4.440892098500626e-16 A/m²`,
H `6.760249178929324e-9 A/m`; 12 środków i 48 lokalnych śladów J,
108 geometrycznych momentów RT0 oraz 36 bilansów elementów.
Odbiór dotyczy tego modelu i próbek poza źródłem, nie taper/inside-source,
zamknięcia obwodu ani zakwalifikowanej bazy do LLG/FFT.
Pełny raport zachowuje `physics_qualified=false`,
`native_canonical_bundle_redecoded=false` i brak kwalifikacji trwałości.
Nowe `--write-report` zapisuje wynik z SHA narzędzi w `export/V-J-H-comparison.json`
wyłącznie po sukcesie i przy niezmienionych źródłach podczas porównania.
Kolejny etap: rzeczywista publikacja HTTP i canonical disk-loader w osobnej
sesji RAM przez publiczny runtime, bez sztucznych stage refs ani zmiany
guardów SessionStore. Workspace 3197 nie był zmieniany.

**Odbiór narzędzi porównania V/J/H — 2026-10-11:**
Hostowy reader rozdziela exact export v1/v2, w tym manifest, jednostki,
receipt i payload snapshotu J. Legacy v1 pozostaje bez J; mieszane generacje,
złe hashe, dodatkowe pliki i błędne liczności są odrzucane.
`scripts/antenna_current_display_fixture_check.py::decode_current_snapshot`
wiąże bounded snapshot z retained bundle/charge/source, whole-mesh Tet4,
stable IDs i bitami XYZ. Nie rekonstruuje ani nie uśrednia native J.
`compare_current_display_fixture` sprawdza niezależny stały model:
12 środków, 48 cell-local traces, J=I/A, affine consistency oraz
48 device face moments i bilanse elementów. Tolerancje i ograniczenia:
nota 0950, `DOC-ANCHOR:antenna-current-source-fixture-current-display-check`.
Comparator RAM wykonuje te kontrole przed V/H dla v2 i zachowuje v1.
HTTP smokes weryfikują v1/v2, scope/revision/digest, SI, ETag, Range,
snapshot oraz bitową zgodność czterech carrierów J z zachowanymi próbkami.
Liczniki vertices/elements są admitted przed iteracją; regresje obejmują
zero i maksymalne u64 także po ponownym obliczeniu hashy/pinów.
Wykonane interpretowane dowody: reader/snapshot/comparator **73 PASS**;
istniejące RT0/oracle/RAM launcher **63 PASS + 12 subtestów**;
HTTP smokes **74 PASS + 49 subtestów**. Focused scientific validator exit 0.
Niezależny review snapshotu/oracle nie wykazał Blocker/Required;
Required count admission z review HTTP poprawiono i przetestowano.
To syntetyczne testy readerów i transportu oraz prywatny fixed-fixture oracle,
nie dowód native solve, canonical re-decode, rzeczywistego endpointu ani fizyki.
Nie kompilowano testów jednostkowych. Nowe narzędzia powstały po capture
buildu nr 41; nie zmieniają jego zamrożonych źródeł ani pakietu.
W chwili tego wcześniejszego checkpointu odczyt API joba nr 41 zwracał
`running`, exit code null. Późniejszy odbiór terminalnego sukcesu i rzeczywisty
RAM run opisano powyżej; nie zgłoszono drugiego buildu.
Publikacja/cold-load/HTTP, obwód, per-A, FFT, LLG i T00–T18 pozostają otwarte.
Workspace 3197 i jego sesja nie zostały zmienione.

**Zapis etapu i build integracyjny — 2026-10-11:**
Spójny przyrost producent/ABI2 → Rust decoder/archive v2 → typed API →
wspólny Inspector/renderer raw J zapisano jako
`62d9618b2eebec639e52eeea842ffde19525a4bd`. Zakres i dowody poniżej;
nie zamyka to fizyki, rzeczywistego runtime ani całego T00–T18.
Po commicie worktree było czyste; changed-scientific-docs gate exit 0.
Zgłoszono dokładnie jeden `fem-cpu-release` build przez istniejący,
zdrowy koordynator: nr 41, `1128d9f468ee4b0981387a8cdf448451`.
Tryb `commit`, pełny SHA powyżej, `source_snapshot_dirty=false`;
kapsuła `164ce78afc59e0e195b82c34d9a959762a420416abf4a6fdf0c91669c5059d57`,
native snapshot `ad8075fbd2d058c120537e316de8aff14b7b98563875e0e2668436418cb2e0a2`.
Build przyjęto jako `queued`, ostatni odczyt API: `running`;
brak jeszcze terminalnego wyniku/exit code.
Nie ponawiać submit: obserwować ten job, odebrać receipt i artefakty,
a następnie wykonać solve/publikację/cold-load/HTTP i scientific gates.
Poniższy starszy tekst „WIP” opisuje zakres kwalifikacji, nie brak commita.
Backend/sesja na 3197 nie były zmieniane ani restartowane.

**Aktualny punkt wznowienia — 2026-10-11 (owned snapshot `J_charge`, WIP):**
Natywny producent `solve_accepted_external_lead_display_bundle` zachowuje
legacy bundle i próbkuje J z tego samego live accepted RT0 przed zwolnieniem
ownera. Osobny rekord zawiera środki device Tet4 oraz cell-local vertex traces,
rzeczywiste stable IDs, ordered whole-mesh element index i SHA bundle/charge/source.
Nie używa starszego nodal J ani dodatkowego solve/projection. Nowe ABI
`fullmag_fem_solve_accepted_external_lead_field_v2` korzysta z request v1
oraz osobno wersjonowanego result v2; legacy layout i trzy records są zachowane.
Dokładny J capacity admission następuje przed solve; publikacja obu lengths
i SHA jest wspólna, po kontroli rozłączności buforów i przygotowaniu metadata.
Kontrakt naukowy: nota 0950,
`DOC-ANCHOR:antenna-owned-current-display-snapshot`.
Focused validator: exit 0; interpretowany validator contract **33/33 PASS**;
layout/admission source checks **7/7 PASS**; nie są to wykonania native ani fizyki.
Bounded Rust decoder wiąże snapshot J z zachowanym bundle, charge mesh,
ordered whole-mesh Tet4 i stable IDs/XYZ. Archiwum v1 zachowuje pięć payloadów
i brak J; v2 dodaje `current_display.v1.bin` i wersjonowany receipt. Publikacja
odrzuca mieszane generacje, podwójny manifest i obce pliki. Pełny loader
odrzuca także duplikaty kluczy JSON, brak payloadu i niezgodność pinów.
CLI zapisuje stage record v2 z jednostką J, zachowując nazwę rejestru v1.
Typed API v2 publikuje cztery binarne carriery (środki/ślady × pozycje/J)
oraz oryginalny snapshot; JSON pozostaje lekki. `current_density=true`
dotyczy wyłącznie poprawnie wczytanego wyniku v2, nie samego manifestu.
Frontend rozpoznaje zgodne v1/v2 bez blokowania dotychczasowych V/H.
Interpretowana regresja rzeczywistej bramki frontendu: **48/48 PASS**,
`apps/control-room/scripts/check-antenna-inspection-generation.mjs`.
Produkcja CLI/API source-check: passed/0, receipt
`df13aef3347140d1b688d1f9c70691c3`; OpenAPI: passed/0,
`24bfdfa35fc24762a6c1ba65dc5aeb53`; klient: passed/0,
`e79efc05b5ac4d3fb24c0584f207cd41`; frontend production source-check:
passed/0, `b99eb90dcfe4495b841559ed42412b5d`; API hygiene: passed/0,
`1a44269b4ec34c79901e231833f7cd23`; lint całego frontendu: passed/0,
`5b852c8d09b248fb9cc416e2c1de5705`. Receipty mają niezmienione źródła
przed/po. Frontend check poprzedza dodanie samego interpretowanego skryptu.
Te bramki nie kompilują testów jednostkowych ani natywnego FEM;
regresje Rust są zapisane, niewykonane i niekompilowane.
Build `fem-cpu-release` nr 40:
`c9ed53df3f734af9ae997ea5341c9d80`, terminalny `succeeded`, exit 0.
Sprawdzono 127/127 artefaktów: rozmiary i SHA-256 zgodne z build receipt;
kwalifikacja pozostaje `NOT VERIFIED`. Image
`sha256:e360637ea8b00e280efdca7648ee022e6dd16150b10130b734425bb8a65b5aa0`.
Kapsuła `ebedb8a8855722e4b41e6258e9e314a443311cf214cb4a698a543572fb405d16`,
native snapshot `3d2549e6327b3c7fddb2ac069f6aaa1d8f94a8ecda6a905b939402da54b3beb1`,
bazowy HEAD `4a1cfd9cb8ae363579a9fb1a79bc307b5d177203`.
Ta zamrożona kapsuła zawiera producenta C++/ABI, lecz nie późniejszy adapter
Rust, archiwum, API ani frontend; sukces tego buildu nie zakwalifikuje
całego nowego przepływu i wymaga osobnego, właściwego odbioru runtime.
Nie ponawiać tego joba: do pełnej integracji potrzebna jest nowa kapsuła
obejmująca cały adapter/archive/API/frontend.
Raw J jest już zaimplementowane w rendererze i wspólnym Inspectorze:
surface/wireframe/points/full-XYZ vectors, komponenty x/y/z/moduł, palety.
Cell-local traces nie są uśredniane; shader liczy normę po interpolacji
wektora, points/glyphs zachowują native centers. Immutable carrier jest
oddzielony od stylu i projekcji; geometrie, materiał i LUT nie zmieniają
UUID przy zmianie komponentu, palety lub pojedynczych passów.
Interpretowany adapter: 90/90 PASS. Production frontend source-check:
passed/0, `f21e7af3f6cd4ca09bdd65c93ea9cf91` (przed wyłącznie korektą
oczekiwania gotowości w skrypcie browser; źródła TS/TSX niezmienione).
API hygiene: passed/0, `10a023c6bf634103b7018ef634d621c1`.
Końcowy lint całego frontendu: passed/0, `a4c9831b634c4e7695567890c2ac362e`.
Managed browser `4a3609574f2443f39aed36e46d7db3b0`: passed/0,
16 grup kontroli; before/after digest
`25186155a82134b079022e79c366805768eb914ef712298a0020b58165444e35`.
V/J/H Inspector, rzeczywiste shader GPU cancellation readback, stabilne
zasoby, scoped bounded reads, odmowy i cleanup PASS; screenshot obejrzano.
WebGL niezagubiony, canvas widoczny, drawing buffer niezerowy.
Przeglądy źródłowe adapter/archive/ABI i renderera: bez Blocker/Required.
To wyłącznie kontrolowany test UI, nie prawdziwy solve/HTTP/nauka.
Następne kroki: build pełnej kapsuły, natywny adapter i wykonanie
solve/publikacji/cold-load/HTTP oraz rzeczywista kwalifikacja V/J/H.
Nowe API nie działa jeszcze w uruchomionym zamrożonym backendzie.
Obwód, per-A baza, FFT, LLG/Relax i pełne T00–T18 pozostają otwarte.
Workspace 3197 działa z przebudowanym pakietem HEAD 4a1cfd9c; odtworzono
ostatnią zapisaną pustą scenę, nie starszy model demonstracyjny microstrip.
Nie zawiera jeszcze tego natywnego WIP i nie był ponownie restartowany.

**Audyt BORIS — 2026-10-11:** ukończony raport i manifest dowodów zapisano
w `docs/superpowers/specs/2026-10-11-boris-transport-oersted-antenna-audit.md`
oraz sąsiednim `.evidence.json`. Commit dokumentacji:
`6fbe4a6403d01ef3545bb5ac1500fb0559af6be4`. Przypięte źródła upstream,
równania charge/spin/Oersted, waveform/cache, jednostki, ryzyka i bramki
porównania; potwierdzono permutację indeksów w `_concat_qia`.
BORIS nie był budowany ani uruchamiany; audyt nie promuje capabilities,
nie kopiuje kodu solvera i nie zamyka żadnej bramki fizyki T00–T18.

**Aktualny punkt wznowienia — 2026-10-10 (materializacja kopii wykonawczej):**
Pełny eksport `Problem.to_ir(include_geometry_assets=True)` przygotowuje
`ExternalLeadPreparation` na niezależnej siatce oryginalnego przewodnika.
Actual ordered Gmsh IDs pochodzą z tej samej `MeshData`; raw sink omija cache
samego MeshIR, zachowując istniejący cache NPZ. Authored model pozostaje
niezmieniony, kopia wykonawcza oraz mirror grafu otrzymują zgodne źródło.
W provenance zachowano deklarację i bounded receipt, bez ciężkich arrays.
CLI waliduje lekki root i stage IRs, ale odracza mesh-dependent planning
do pełnego eksportu; obejmuje intencję obecną dopiero w późniejszym etapie.
Interpretowane regresje: **5/5 PASS**, w tym actual Gmsh microstrip/taper
i ponowne wykorzystanie cache; authoring po zmianie: **9/9 PASS**.
`just check-cli-source`: passed/0, receipt
`5b7533947875483a9840202720fa134f`, before/after digest zgodny:
`8fbcbc5ae10aae41616ed96400e1842913ac496ec41834286261d91c69bc8d53`.
Niezależny przegląd: brak Blocker/Required w zakresie przyrostu.
Regresja Rust root/future-stage zapisana, niewykonana i niekompilowana.
Kontrakt naukowy: nota 0950, `DOC-ANCHOR:antenna-execution-lead-materialization`.
To **nie** dowód wykonania V/J/H, zbieżności ani nowego UI. Działający
ostatnio zweryfikowany workspace korzystał z pakietu `97b320d883b55c5df5daa44e5f70196114164c88`.
Kontrola końcowa wykazała zakończenie tego runu: receipt `completed/0`,
brak procesów i nasłuchu 3197/8081; nie zamknięto go w ramach tego przyrostu.
Kolejne bramki: pełny native inspection solve,
compatible sampling carrier także dla target Object przy shared airbox,
rzeczywiste J z owned RT0 oraz odbiór V/J/H w API/viewportcie. Zamknięcie
obwodu, zakwalifikowana baza na amper, FFT/LLG i T00–T18 pozostają otwarte.

**Aktualny punkt wznowienia — 2026-10-10 (jawna deklaracja doprowadzeń):**
Publiczne `ExternalLeadPreparation` i `TerminalLeadExtension` zachowują intencję
przed siatką w Python → scena → eksport Python → `ProblemIR`. Deklaracja nie
zawiera ciężkich danych, rozwiązanej bazy ani certyfikatu zamknięcia obwodu.
Jawne `.prepare(device_mesh=...)` korzysta z dotychczasowego przygotowania
na rzeczywistej niezależnej siatce przewodnika. Bez przygotowania planner
odmawia wykonania; nie wraca do dawnych warunków brzegowych.
Interpretowany authoring: **9/9 PASS**; helper z rzeczywistym Gmsh, microstrip
i taper: **11/11 PASS**. `just check-cli-source`: passed/0, receipt
`f722599ff0d445a7b36fab6b98860ab1`, digest przed/po
`010e6220bf6e62f529e87aebb625ecd5bc05859437805bc305f6fe371cd5266f`.
Produkcja OpenAPI: passed/0 (`e9610c2ff6d745f5b1fdac13295a86a7`),
generacja klienta: passed/0 (`b43e6be6449f488fbdd029f872fa7cd3`),
kontrola źródeł frontendu: passed/0 (`89584c16fa654697a83491d127df800a`).
Walidacja noty 0950 i mapy źródeł: exit 0. Testy Rust zapisane,
ale niewykonane i niekompilowane zgodnie z ograniczeniem projektu.
Te kontrole nie dowodzą wykonania nowego pola przez HTTP ani solvera.
Dokładny kontrakt i ograniczenia: nota 0950,
`DOC-ANCHOR:antenna-authored-lead-preparation`.
Następny krok: wykonawcza materializacja niezależnej siatki z zachowaniem
tożsamości Gmsh i intencji, jeden wynik V/RT0/H, publikacja i wyświetlenie
V/J/H. Zamknięcie obwodu, baza na amper, FFT i LLG pozostają otwarte.

**Aktualny punkt wznowienia — 2026-10-10 (inventory anten w rzeczywistym API):**
Rustowy graf sceny publikuje auxiliary-only `PhysicsObjectIR` w istniejącym
GET `model/physics-graph`. ID pozostają niezmienne; nazwy mają wspólny
trim/fallback, role muszą być kanoniczne, a kolizje są jawnie odrzucane.
Produkcyjny native Windows build `backend-dev`: completed/0; zaktualizowany
Python zawiera poprawkę obsługi nazw/ID. Izolowany HTTP + publiczny capture
Python: **15/15 PASS**, bez zmiany sesji użytkownika. OpenAPI i klient
zregenerowane; `just check-control-room-production-source`: passed/0,
receipt `f89be0bfd0cc49a6bc8afd97260ddea0`.
Dokładne hashe i scope dowodu: nota 0950,
`DOC-ANCHOR:antenna-auxiliary-graph-http-evidence`.
Nie jest to obliczenie pola ani zamknięcie T00–T18. Następna granica:
publiczny typed intent doprowadzeń → execution-only przygotowanie siatki
źródła → jeden wynik V/RT0/H → publikacja i odbiór V/J/H w UI.
Kwalifikacja closed-circuit basis, FFT, LLG i czterech lane nadal otwarta.

**Aktualny punkt wznowienia — 2026-10-08 (implementacja przepływu UI → source → display):**
[Domknięcie end-to-end](2026-10-08-antenna-end-to-end-gap-closure.md) porównuje
rzeczywisty stan z T04/T05/T06/T14/T15 i rozpisuje kolejność dalszych prac.
Geometry/root zapisano jako `28c41969e77213afa01139bb8afecf3fe34e1542`.
Inspekcja external-lead nie jest qualified basis; pełny producent źródła,
renderer V/J/H oraz odbiór FFT/LLG nadal wymagają implementacji i wykonania.
Nowszy checkpoint zastępuje poniższe historyczne wskazanie następnego kroku,
nie zmieniając znaczenia wcześniejszych dowodów ani checkboxów T00–T18.

Uzupełnienie 2026-10-08: [checkpoint inwentarza eksportu sceny](2026-10-08-antenna-scene-export-inventory-checkpoint.md)
naprawia pomijanie anten w Rust override dla istniejącego skryptu. Solver
projection pozostaje magnetic-only. Python round-trip i production API
source-check PASS; wykonanie adaptera Rust/endpointu oraz UI nadal nieweryfikowane.

Uzupełnienie 2026-10-08: [checkpoint JSON widma](2026-10-08-antenna-spectrum-json-checkpoint.md)
wiąże verifier, cache oraz API metadata/payload widma ze wspólnym parserem
odrzucającym duplikaty. Produkcyjny typecheck API przeszedł; regresja Rust,
endpointy, legacy v1 i kwalifikacja numeryczna FFT pozostają niewykonane.

**Aktualny punkt wznowienia — 2026-10-08 (produkcyjny typecheck źródeł):**
`just check-cli-source` dla czystego HEAD
`fbae293cca60562d71a404b954e7444138f45a45` zakończył się `passed`, exit 0.
Receipt `c090f270323a4b8eb041f1823e2002ed` i `cargo.log` znajdują się pod
resolverowym profilem `windows-api-source-check/cli-source-check` tego worktree.
Digest przed/po jest identyczny:
`df7087213f62b18acd9a112d66d5a75312cb429348bda195f360e13c85c19bfd`.
Kontrola obejmuje produkcyjny CLI i jego zależności, w tym runner, planner i IR;
potwierdza typy zmian duplicate-key, cold-load, inventory oraz agregacji pamięci.
Uzupełniający `just check-api-source` również zakończył się `passed`, exit 0:
receipt `f7003a6a749b421b8350027bb5060bed`, profil
`windows-api-source-check/api-source-check`; digest przed/po
`b0aa57eba67541e57f930325cb9152e03989e9857a3917273ecaa579c6a17514`.
HEAD ten sam, podczas kontroli zmienione wyłącznie checkpointy dokumentacji;
źródła objęte receiptem pozostały niezmienione. API check obejmuje produkcyjne
konsumery sceny/inventory, nie uruchamia endpointów ani komend.
Nie kompiluje `cfg(test)`, native FEM/CUDA ani kompletnego pakietu wykonawczego.
Ostrzeżenia kompilatora pozostają w logu; wynik nie oznacza warning-free build.
Wykonane wcześniej regresje Python authoringu opisano w checkpointach pasma
i próbkowania widma. PR #147 pozostaje Draft, bez merge.
Sesja `session-18dc56634a2145f00000e874` nadal odpowiada jako
„Antenna frontend regression 2026-10-07”, `awaiting_command`; nie zamykano jej.
Następny krok: bezpieczna przebudowa pakietu po rozwiązaniu blokady aktywnego
workspace i wykonanie native/cold-load/static/LLG/FFT. T00–T18 pozostaje otwarte.

**Poprzedni punkt wznowienia — 2026-10-06 (katalog → zweryfikowany asset, WIP):**
`crates/fullmag-cli/src/orchestrator.rs::read_ready_antenna_stage_outputs`
nie traktuje już samego istnienia manifestu jako wystarczającego odbioru wyniku.
Wspólny `crates/fullmag-runner/src/antenna_stage.rs::load_published_antenna_field_solution_for_port`
wykonuje dotychczasową pełną kontrolę integralności manifestu/payloadów,
potem sprawdza solution/output identity i obecność oczekiwanego portu.
Reader katalogu porównuje również bajty wskazanego manifestu z assetem,
odmawiając podstawienia innego legacy/revision manifestu.
Jest to odbiór integralności historycznego wyniku, nie aktualności modelu:
konsument nadal wymaga Expected/current revisions przed projekcją.
`scripts/test_antenna_catalog_asset_source.py::class AntennaCatalogAssetSourceTests`:
RED2 → GREEN2/2; scoped whitespace PASS. Test Rust
`catalog_port_loader_checks_integrity_before_port_membership` zapisany, niewykonany.
CLI fixture `test manifest` jest teraz jawnie negatywnym przypadkiem zamiast
pozornego poprawnego ready assetu; pozytywny fixture wspólnego loadera powstaje
przez istniejący canonical artifact builder w teście runnera.
Nie kompilowano testów Rust, nie wykonano nowego solve ani LLG/Relax.
Zmiana pozostaje w spójnym zależnym WIP; seq37 jej nie obejmuje.
Następny krok: produkcyjny build bieżącego snapshotu i wykonanie integralności
katalogu/reuse; pełny T00–T18 oraz rzeczywisty workflow UI nadal otwarte.

**Poprzedni punkt wznowienia — 2026-10-06 (silniejszy odbiór cache, WIP):**
`crates/fullmag-runner/src/antenna_stage.rs::inspect_cached_antenna_field_solution`
otwiera teraz kandydata ready przez `load_expected_antenna_field_solution`,
z sygnaturami aktualnego planu oraz geometry/material/mesh z jego bound request.
Wcześniej używał loadera integralności bez bieżących rewizji źródła.
Wcześniejsze Missing/Stale, niezależność pola źródła od projekcji targetu
i porównanie ponownie odczytanych bajtów manifestu pozostają zachowane.
Regresja źródłowa `scripts/test_antenna_cache_expectation_source.py::class AntennaCacheExpectationSourceTests`:
pierwsze dwa przypadki RED 1 failure → GREEN 2/2; po dodaniu kontroli
klasyfikacji i race guard wykonany zestaw GREEN 3/3. Nie jest to wykonanie Rust ani
kwalifikacja cache/reuse w runtime. Zmiana zależy od WIP Expected/readers
i nie może być osobnym commitem przed domknięciem ich zależności.
Build seq37 `39cfbbe88c2f4d7e817205015cb4fab8` nadal running przy ostatnim
odczycie; jego immutable source capture poprzedza tę poprawkę, więc nawet
sukces tego buildu nie potwierdzi nowego kodu cache.
T00–T18, cztery lane i pełny workflow UI pozostają otwarte.

**Poprzedni punkt wznowienia — 2026-10-06 (aktywacja i nieaktualne bazy):**
`ecd3d392a14acd603a59e4067df5083a92d8cac4` zapisuje samodzielny
activation preflight: zgodny study/stage, clear empty/inactive FEM/FDM,
odmowa aktywnej unsupported lane. Dalszy committed asset verification
i projection byte-identical. Parent source RED3 → rzeczywisty INDEX3/3;
korelacja8/8, whitespace PASS, tree INDEX/commit identyczny.
Pełny working orchestrator zachowany. WIP workflow zawsze wykonuje
ten sam preflight przed root; trzy nowe regressions RED3 → pełne33/33.
Strong Expected/current freshness nie osłabione. Independent bounded
review bez Required/Blocker; Rust/runtime NOT VERIFIED.
Szczegóły i pełne domknięcia zależności:
`DOC-ANCHOR:antenna-consumer-activation-preflight` w 0950.
Następna granica: podpisy/readery → referencje/katalog → projekcja/guards
→ kompletny routing → zegary/resume. Nie stage'ować monolitów jako fasad.
Seq36 odebrany succeeded/0,126artefaktów i7453/79 kapsuła; tylko starszy pakiet.
Zgoda RAM fixed V/RT0/H, bez LLG/Relax; T00–T18/cztery lane/UI/integracja otwarte.

**Poprzedni punkt wznowienia — 2026-10-06 (commit propagacji błędów obserwacji):**
`46daf528dc529f02888a09e6e2746e406082f2a5` domyka źródłowo energy no-op
z poprzedniego commita: fallible readiness, trzy jawne komendy propagują
błąd, energia odmawia braku runtime, import przygotowuje stan przed
continuation/generation. Idle warning zachowuje polling; duplicate upload
usunięty z uzasadnieniem konstruktorowym FDM/FEM. Resync error usuwa runtime:
nie jest to pełny rollback. Przygotowanie rozwiązanych baz nadal w WIP.
Dokładny parent RED 5 testów/6 failures; rzeczywisty INDEX GREEN 5/5 i
dotychczasowe source checks 8/8. Finalny whitespace PASS. Dwa staged pliki,
review wszystkich linii i niezależny bez Required/Blocker, working host
byte-identical, tree index/commit identyczny. Rust/native niewykonane.
Szczegóły: `DOC-ANCHOR:antenna-observation-readiness-commit` w 0950.
Seq 36 odebrany terminalnie succeeded/0: trusted journal i receipt,
126 artefaktów oraz pełne 7453 pliki/79 included untracked PASS.
Starsza kapsuła nie kwalifikuje nowego HEAD ani runtime/nauki.
Szczegóły: `DOC-ANCHOR:antenna-build36-terminal-package-acceptance` w 0950.
Zgoda RAM fixed V/RT0/H; pełne T00–T18/cztery lane/UI/integracja nadal otwarte.

**Poprzedni punkt wznowienia — 2026-10-06 (commit pełnej korelacji compute/import):**
`48e8f622427856b70a044bc1a8e18cf09f4b27dd` zapisuje siedem zależnych plików:
CLI optional ID/lock/upsert i 16 producentów, API strict presence/freshness/
readiness, fixtures session/router oraz niezależne source checks.
Dokładny parent RED: 8 testów, 7 failures i 2 errors; rzeczywisty INDEX GREEN
8/8, whitespace PASS. Rust fixtures niewykonane i niekompilowane.
Przegląd wszystkich staged linii i niezależny review bez Required/Blocker;
sześć pełnych working files byte-identical. OpenAPI shape bez zmian.
Znany osobny problem: `InteractiveRuntimeHost::compute_current_energies`
może zwrócić Ok bez runtime; wymaga naprawy i wykonanej regresji. Korelacja
wyniku nie dowodzi fizycznego obliczenia. Durable outcome, eviction/replay,
generic idle i paused-resume atomicity pozostają otwarte.
Seq 36 nadal running; log etapu native-build kończy się exit 0, cały build
bez terminalnego receipt. Kapsuła poprzedza oba commity ID.
Szczegóły: `DOC-ANCHOR:antenna-command-result-correlation-commit` w 0950.
Zgoda RAM wyłącznie fixed V/RT0/H; T00–T18 i cztery realizacje nadal otwarte.

**Poprzedni punkt wznowienia — 2026-10-06 (samodzielny commit izolacji ID):**
commit `140987ee9b4a2d896132a050dfbf3c193b579e5d` obejmuje wyłącznie
`crates/fullmag-api/src/session.rs`: exact match każdego jawnego ID,
helper i 24 zapisane przypadki Rust. Zachowuje HEAD-ową obsługę anonimowych
logów (`None => true`); obowiązkowa obecność ID dla compute/import pozostaje
w zależnym WIP. Nie zastępuje pełnej docelowej migracji.
Samodzielne source checks na dokładnym HEAD były RED 2 FAIL;
na rzeczywistym staged blob GREEN 2/2 PASS, staged whitespace PASS.
Sprawdzono identyczność commit/index blob oraz niezmienione bajty pełnego WIP.
Niezależny dependency review nie znalazł blokera w tym jednym fragmencie;
Rust/native tests niekompilowane i niewykonane. Seq 36 nadal running,
bazowy HEAD `6de68ca35e41b617f21d05e264856630e0741aff`, kapsuła przed
obecną izolacją ID. Następny commit pełnej migracji wymaga razem producentów
CLI, exact bridge/readiness i fixtures API/router; nie dołączać jej osobno.
T00–T18, runtime, science, UI i integracja pozostają aktywne.

**Poprzedni punkt wznowienia — 2026-10-06 (izolacja jawnego ID komendy):**
globalny API matcher sprawdza każde obecne `command_id` dla wszystkich
rodzajów komend, nie tylko compute/import. Obcy log `failed`/`Error`/`cancelled`
nie zmienia statusu innej komendy nawet w tej samej milisekundzie.
Źródłowe RED 1 FAIL/29 PASS → końcowe GREEN 30/30 PASS; zapisano 24
przypadki Rust, **nie kompilowano i nie wykonano**. Niezależny bounded review
nie pozostawił problemu w kodzie; wymaganą korektę dokumentacji zastosowano.
Anonimowe logi, generic idle completion, eviction/recovery i paused-resume
atomicity pozostają otwarte. Nie jest to pełna kwalifikacja lifecycle.
Seq 36 `ba55fc79175c4a57a335bab7b1efc0e8` nadal running w ostatnim odczycie;
jego kapsuła poprzedza tę poprawkę, zatem nie będzie jej dowodem kompilacji.
Szczegóły: `DOC-ANCHOR:antenna-command-log-explicit-id-isolation` w 0950.
Zgoda RAM pozostaje wyłącznie fixed V/RT0/H, bez LLG/Relax i nowych fixtures;
pełne T00–T18, runtime, science, UI i integracja nadal aktywne.

**Poprzedni punkt wznowienia — 2026-10-06 (R3 API i handoff):** seq 35
`feb603f43c5b4dfa98777f87d5422411` odebrany terminalnie `succeeded`/0:
trusted receipt/journal, 126 artefaktów oraz pełna kapsuła 7448 plików
(78 included untracked) PASS. Exact OpenAPI export succeeded/0; receipt/proof/raw
import potwierdził nowe DTO kwadratury R3. Regeneracja klienta, production
TypeScript i API hygiene PASS/0; bez kompilacji testów jednostkowych.
Źródłowo poprawiono rozwiązywanie `StageOutput` przed gotowością finalnego
szablonu oraz dla nowego interactive stage przed nową `single_current`
sequence/plan/load. RED 2 FAIL/27 PASS → GREEN 29/29 PASS; niezależny review
kodu bez Required/Blocker, dokumentacja zawęża zakres zgodnie z review.
Nie jest to transakcja istniejącej sekwencji/paused resume ani runtime proof.
Kapsuła R3 poprzedza tę korektę i matched-libm reader. Kolejny production
build `fem-cpu-release` przyjęto jako seq 36,
job `ba55fc79175c4a57a335bab7b1efc0e8`, z 79 jawnie wskazanymi wejściami;
source digest `6115532bdbe5bd93d14ac8802d65de2074caf5ce72212ba9074e9beadcf430a6`,
native snapshot `dff597e0229601109906d34e500b980c754216d45d1dfdf570853c8ac9d0b0f1`,
bazowy HEAD `6de68ca35e41b617f21d05e264856630e0741aff`.
Terminalny odbiór tego buildu i runtime handoff pozostają wymagane.
Zakres zgody RAM nadal wyłącznie fixed
V/RT0/H, bez LLG/Relax, nowych fixtures i kwalifikacji trwałości SessionStore.
Na tym dokładnym R3 wykonano zatwierdzony fixed test RAM: solver/container
exit 0, independent V/H, geometryczne momenty RT0 i bundle association PASS.
Maksymalne błędy: V $1.11\times10^{-16}\,\mathrm V$,
H $6.76\times10^{-9}\,\mathrm{A\,m^{-1}}$.
To nie reusable basis, publikacja raw evidence, pełna nauka ani trwałość.
Szczegóły w 0950: `DOC-ANCHOR:antenna-r3-fixed-ram-comparison`,
`DOC-ANCHOR:antenna-r3-package-openapi-acceptance`,
`DOC-ANCHOR:antenna-scripted-interactive-output-handoff` oraz
`antenna-r3-api-handoff-checkpoint-20261006.json` w storage.
Pozostałe bramki T00–T18, science, runtime, UI i integracja nadal otwarte.

**Poprzedni punkt wznowienia — 2026-10-06 (R2 matched libm):** wdrożony jawny
adapter `hypot@GLIBC_2.35` z expected file SHA, resolved-symbol path i
nearest-even, bez fallbacku/ULP slack; przekazywany CLI→verify→cold reader→decoder.
Końcowe source-bound interpreted Linux **37/37 PASS**, corpus 12012:
0 różnic finalnej tolerance. Windows 30 PASS i dwa wpisy SKIP; wrapper
2/2 PASS. Niezależny review kodu bez Required/Blocker; nie operator solve.
Parametry, zakres i dowody w 0950,
`DOC-ANCHOR:antenna-matched-libm-reader-realization`, oraz
`antenna-matched-libm-evidence-20261006.json`. Producer/input provenance,
pełne producer-math qualification, trzy native poziomy, R3 publication,
runtime/fizyka i T00–T18 pozostają otwarte; nie promować instrumentacji
do odbioru modułu. Build R3 seq 35 wymaga aktualnego terminalnego odczytu.

**Poprzedni punkt wznowienia — 2026-10-06 (R2 libm):** odrębna diagnostyka
12012 wektorów w przypiętym obrazie wykazała 111 różnic Python/GNU libm
nested hypot i 57 różnic finalnej tolerance; rational FMA na tej samej normie
libm ma 0 różnic. Nie jest to native operator solve. Nie promować wcześniejszego
4/4 PASS do ogólnego parity: obecny reader wymaga kwalifikowanej realizacji
normy z producer/runtime provenance albo jawnie wersjonowanej migracji
algorytmu, bez allowance ULP. Kontrprzykłady i dalsze warianty w 0950,
`DOC-ANCHOR:antenna-libm-parity-counterexample`, evidence `antenna-libm-parity-evidence-20261006.json`.
Czytnik R2 i zamknięta trasa zostały zapisane jako commit
`2ef4de4dffb5eb9d83542feb3541cf892fe29c5c`; to instrumentation, nie science.
Build R3 seq 35 nadal running. Pełne T00–T18 i integracja aktywne.

**Poprzedni punkt wznowienia — 2026-10-06 (R2 runtime):** te same cztery retained
native tolerancje są bitowo zgodne także w docelowym obrazie Python Linux
3.10.12/glibc 2.35: 4/4 PASS. Wywołano tylko pinned źródło czytnika, bez
solvera/sesji/LLG/Relax; nie jest to pełny libm parity ani R3 qualification.
R3 seq 35 nadal running. Dowód w `retained-native-tau-linux-evidence-20261006.json`.

**Poprzedni punkt wznowienia — 2026-10-06 (T18):** pierwszy przykład noty 0950
jest teraz pełnym aktualnym skryptem stage-first current-source inspection.
Regresja literalnej kopii oraz Python→IR/export/reimport: RED 1 FAIL/1 ERROR
(stary fragment bez importu fm), GREEN 2/2 PASS; bez solvera, LLG/Relax lub
nowego RAM. Inspection-only nie zastępuje pełnego solve→qualified basis→LLG/FFT
ani końcowej dokumentacji produkcyjnej. R3 seq 35 running, odbiór nadal otwarty.

**Poprzedni punkt wznowienia — 2026-10-06:** dodatkowy read-only check zachowanego
fixed RAM potwierdził bitową zgodność 4/4 tolerancji native z niezależnym
R2 Python (`0 ULP`), bez nowego solve i bez zmiany progów. Nie zamyka pełnego
libm parity ani R3/provenance. Seq 34 odebrany terminalnie: succeeded/0,
trusted dokumenty, 126 artefaktów i pełna kapsuła 7445 plików PASS;
seq 35 running. To kwalifikacja pakietu R1, nie runtime/fizyki ani R3.
Dalej terminalny odbiór R3, właściwy R3 export/OpenAPI/TS i otwarte T00–T18.

**Poprzedni punkt wznowienia importu — 2026-10-06:** importer OpenAPI ma jawną trasę
snapshot receipt/proof/raw-byte-bound: RED 5 nowych FAIL / 17 starych PASS,
GREEN 22/22 PASS oraz API hygiene PASS. Rzeczywisty eksport seq 33 odczytany
przez walidator: PASS, dirty provenance zachowane, bez publikacji starego
kontraktu R1 jako R3. Następnie terminalny odbiór seq 34/35 i właściwy eksport
R3, generated OpenAPI/TS, runtime/nauka i wszystkie otwarte T00–T18.
Nie powtórzono niezmienionego RAM; zgoda dotyczy tylko fixed nauki w RAM,
bez LLG/Relax i bez kwalifikacji trwałości. Szczegóły w checkpointcie importu.

**Poprzedni punkt wznowienia eksportu:** dodano i wykonano rygorystyczny
eksport OpenAPI dokładnego WIP przez `export-runner-openapi-snapshot`:
32 interpretowane regresje, 31 PASS / 1 Windows symlink SKIP oraz realny
eksport seq 33 succeeded/0, retained raw/receipt/proof i input hashes PASS.
Dirty provenance zachowane; pakiet seq 33 nie ma DTO R3 i nie został
użyty do regeneracji kontraktu. Dalej snapshot import z receiptem po
stronie generatora, terminalny odbiór seq 34/35 i właściwy eksport R3,
OpenAPI/TS oraz wszystkie otwarte bramki T00–T18. Bez nowego RAM/LLG/Relax.

**Poprzedni punkt wznowienia R2:** R2 niezależny reader raw evidence
wdrożony i wykonany na synthetic plikach: 26 testów, 25 PASS / 1 Windows
symlink SKIP, CLI PASS; niezależny review bez Required/Blocker. Regularne native trzy poziomy,
libm parity i niezależny producer/input provenance nadal wymagane.
Build producenta R1 seq 33: succeeded/0 oraz trusted receipt, artefakty
i cała kapsuła 7443 plików PASS; nie obejmuje R1 adaptera, R3 ani R2.
Adapter seq 34 running, R3 seq 35 queued w bieżącym odczycie API.

**Poprzedni punkt wznowienia R3:** R3 źródłowo podłączony:
osobny bounded raw binary evidence, wspólna bramka native/cold reader,
publisher i oba loaders oraz API metadata/payload. Interpretowane
wire/binary64/source checks: 14 PASS; regresje Rust zapisane, nie wykonane.
Niezależny review runner/codec oraz API nie pozostawił Required/Blocker.
Dokładny R3 build `feb603f43c5b4dfa98777f87d5422411` (seq 35) jest queued;
OpenAPI/TS regeneration i aktualny R3 build/runtime pozostają otwarte.
Dalej pełny R2 verifier oraz pozostałe T00–T18 i integracja.
Nie promować źródeł ani starszego fixed RAM PASS do qualification.

**Historyczny punkt wznowienia R1:** R1 typowany adapter pełnego
snapshotu podłączony źródłowo, 4 interpretowane source/model checks PASS,
niezależny review bez Required, focused science/plan validators PASS.
Nowy immutable job `7cd410e7025143c8aae5a44ba796ec4e` (seq 34) jest queued,
pełna kapsuła 7445 plików / 75 untracked i 3 adapter source pins PASS.
Kompilacja i runtime adaptera nadal NOT VERIFIED. Poprzedni native producer
job `5d2e8e253c58405c9d44237cd9d2bce2` jest running i nie zawiera tych zmian
Rust. Dalej R3 osobny raw binary artifact + publish/load/per-A binding,
R2 pełny verifier oraz pozostałe bramki T00–T18 i integracja.

> **Dla wykonawcy:** realizuj zadania kolejno przy użyciu `executing-plans`; jeśli praca zostanie jawnie rozdzielona na agentów, stosuj `subagent-driven-development`. Każda pozycja `- [ ]` wymaga rzeczywistego wykonania i dowodu. Nie oznaczaj jej jako zakończonej na podstawie samego kodu.

**Cel:** usunąć wszystkie problemy wskazane w [audycie z 2026-09-08](../../audits/2026-09-08-microwave-antenna-worktree-audit.md), a następnie domknąć reprodukowalny przepływ przewodnik 3D → prąd → baza pola → relaksacja bez RF → LLG z RF → wyniki w Python i Control Room.

**Architektura:** wspólne obiekty, geometria, materiały i CurrentTransport są właścicielami fizyki. Antena wiąże terminale w porty, uruchamia niezależny solve pola i dostarcza immutable wektorową bazę na amper. LLG, frontend i analizy konsumują ten sam wynik przez jawne projekcje i wersjonowane kontrakty.

**Stos technologiczny:** Python DSL, Rust IR/planner/runner/API, MFEM/hypre CPU, istniejące konserwatywne RT0 i adaptacyjne Biot–Savart, natywne realizacje FEM/FDM, Next.js 16/React, generowany OpenAPI v2, istniejący facade i resource hooks, Vitest/Playwright oraz kontenerowe recipes `just`.

**Status na 2026-10-06, 00:13 UTC:** częściowo zaimplementowany, bez odbioru produkcyjnego. HEAD `202bbed4fff8c72099ef17489134bb1df911c090`; zależny WIP zachowany. Globalny target-ledger v3 i accepted field framing v2: interpretowane regresje 233 PASS i 29 podtestów PASS. Build `e57249b5b5d1493b9949204336efcbef` terminalny succeeded/0; trzy etapy, 126 artefaktów, trusted/receipts i cała kapsuła 7442 plików PASS. Zatwierdzony siódmy RAM `8031eeff9ebf4ce28cca1fe5e8613329`: solver 0, isolation/startup PASS, V/RT0/exact association/H oracle PASS bez zmiany progów, bez LLG/Relax. Maksymalny błąd H 6.760249178929324e-9 A/m; każdy punkt poniżej 10% bramki. Jest to wyłącznie fixed outside-source model przy 1 A, nie kwalifikacja modułu ani trwałości. Historyczny sixth v1 H FAIL 3/4 zachowany. Punkt wznowienia: checkpoint **„siódmy fixed RAM v3: V/RT0/H PASS, regularna publikacja nadal otwarta”** w T12; dalej kontrakt naukowy i naprawa eksportu/publication/load/verifiera. Pełne T00–T18, closure, cztery lane, standalone, LLG/FFT/UI, trwałość oraz integracja nadal otwarte. Znany `origin/master` nie jest świeżym odczytem remote; starsze checkpointy zachowują historyczne tożsamości.

**Historyczna aktualizacja po siódmym RAM, przed adapterem R1 i R3:** R1 native producer pełnego snapshotu v3 zapisany źródłowo, 8 interpretowanych source/layout checks PASS i niezależny source review bez dalszych Required. Nowy immutable build `5d2e8e253c58405c9d44237cd9d2bce2` jest running; pełna kapsuła 7443 plików i 4 source pins PASS, bez terminalnego receipt/artifact odbioru. Nowy symbol nie jest jeszcze używany przez runner ani wykonany w runtime. Punkt wznowienia: checkpoint **„R1: append-only native snapshot zapisany źródłowo”** w T12; obserwować dokładny build, następnie typed adapter i binary publish/load/verifier. Siódmy RAM zachowuje zakres poprzedniej kapsuły, nie kwalifikuje tego eksportu.

**Jak czytać checklistę:** `[x]` oznacza zamknięcie podanego zakresu, a `[ ]` brak pełnego odbioru danej pozycji; część takich pozycji ma już implementację lub historyczny wynik testu. Nie wyliczać procentu ukończenia z liczby checkboxów. Dopiski o pozytywnych testach nie zamykają automatycznie całego zadania ani innych backendów. Wynik historyczny wymaga wskazania rewizji i zakresu; zmiana właściciela kodu wymaga ponownej weryfikacji.

Pierwotna podstawa planowania: dirty snapshot audytu, HEAD `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5`, lokalny master `7faa259c5597ba447c413f2aea0ff66d6110b297`. Późniejszą integrację opisuje [punkt bazowy](../../validation/antenna/integration-baseline.md). Nie jest to potwierdzenie synchronizacji z najnowszym zdalnym masterem na 2026-09-20.

Rozpoczęcie: 2026-09-08. Ukończenie dokumentu: 2026-09-09. Nazwa pliku zachowuje datę rozpoczęcia wspólnego audytu i planowania.

## Ograniczenia globalne

Aktualizacja 2026-10-06 00:13 UTC: globalny ledger H v3 i input policy v3
mają źródła, interpretowane regresje, source review, pełny managed build
oraz ograniczony fixed RAM V/RT0/H PASS. Zwykła publikacja/load/verifier
ma odrębne required luki opisane niżej. Nie ma kwalifikacji modułu.
Punkt wznowienia: checkpoint **„siódmy fixed RAM v3: V/RT0/H PASS,
regularna publikacja nadal otwarta”** w T12. Najbliższy krok: kontrakt
naukowy i bounded owned eksport v3, retained numerical acceptance i
normalizacja raw-current/per-A, verifier bez osłabienia progów.
Nowszy source checkpoint R1 ma nowy native snapshot eksport i build
`5d2e8e253c58405c9d44237cd9d2bce2` w toku. Siódmy RAM nie obejmuje
tego symbolu; typed adapter i publish/load/verifier nadal wymagane.

Poniższy succeeded build i sixth RAM są **historycznym dowodem v1**:
RT0 PASS, H FAIL. Nie opisują nowej korekty, nie ponawiać starego pakietu
jako testu v3. Pakiet `a88fb51824264026a7fca17d89f1e30f` jeszcze nie
zawierał wspólnego evaluatora RT0. Zachować wszystkie historyczne odmowy.

Build tej korekty: `76c2851f50454866aba697c672b30b56`,
profil `fem-cpu-release`, terminalny `succeeded`, exit 0. Capsule capture
`4b0de6dd66f4497d84d8cfffa2fa4312`, source digest
`73909aa3db1131ff268a372452018257c8523a3cc8f0351679ea547695446dbd`,
native snapshot
`2880644767f0370adf18a1975ea723ac56c555bc5f10a91638940e93ce7894a3`.
Jawnie włączono 69 nowych wejść i sprawdzono hashe helpera, assembly,
Oersteda, CMake oraz dwóch regresji względem kapsuły: PASS. Pełny validator
126 artefaktów PASS. Wynik builda nie jest naukowym odbiorem pola H.

- Najpierw naprawić semantykę, następnie integrację i ergonomię. Nie promować niezweryfikowanego feature flagiem UI.
- Pozostawić Tier 1 jako jednokierunkowy model DC/quasistatic; nie dopisywać do niego S-parametrów, dBm ani impedancji bez osobnej fizyki.
- Nie wracać do 2.5D dla taperów/przewężeń. Nie zastępować źródła przewodnikowego regionalną maską.
- `object_id`, nazwa, typ prezentacyjny i aktywowane moduły fizyczne pozostają osobnymi pojęciami. Typ `antenna` nie uruchamia fizyki.
- Wszystkie istotne parametry muszą przejść Python → IR → planner → runtime → artefakt → OpenAPI → UI/export.
- Zachować `H_ant` w A/m i bazę `H_ant_basis` na amper. `mu0 H` jest transformacją jednostki prezentacji.
- MFEM/hypre/RT0/Oersted pozostają w `backends/fem`; runner nie dostaje nowego solvera FEM ani numeryki portów.
- Nie dodawać fizyki do `Context` ani `mfem_bridge.cpp`. Zachować wyłączony domyślnie profiler solvera.
- Native build i runtime proof wykonuje kontenerowe `just`. Host `cargo`/`cmake` nie stanowią finalnego dowodu FEM.
- Windows: Docker Desktop Linux engine i istniejące zarządzane launchery; build/cache/pnpm/Playwright poza checkoutem. Nie kopiować linuxowych ścieżek mountów do Windows bez ich weryfikacji.
- Jedna scena, jeden ribbon i wspólna ścieżka viewportu. HTTP v2 jest źródłem stanu; websocket tylko zdarzenia i invalidation.
- Zachować Next.js 16, `fm-` w klasach CSS, tokeny `--fm-*`, wspólne primitives i import-only `app/globals.css`.
- Zachować poprawki master dla mixed meshes, frozen spins i wymuszonego GPU. Nie nadpisywać całych plików jedną wersją gałęzi.
- Test RED musi przejść przez wadliwą granicę: mock DTO nie zastępuje transakcji, zgodne moduły FFT nie zastępują zgodnej fazy, hash pliku nie zastępuje aktualności modelu.
- Każdy commit obejmuje tylko zadanie. Bezpośrednio przed commitem osobno wykonać `git diff --cached --name-only`; nie łączyć tego polecenia z `git commit`.

(plan-problem-statement)=
## 1. Mapa problemów na zadania

| Problem lub luka z audytu | Zadania | Warunek zamknięcia |
|---|---|---|
| F01: utrata kompozycji sceny | T03, T04, T15 | Prawdziwa transakcja i round-trip zachowują wszystkie referencje |
| F02: znaki i niewykonywany kontrakt prądowy | T02, T05, T06 | Podpisane prądy zgadzają się z portem i są rzeczywistymi ograniczeniami solve |
| F03: RF podczas Relax | T07, T13 | Domyślna antena nie wpływa na równowagę |
| F04: stale artifact | T08, T12 | Konsument porównuje aktualne zależności, nie tylko bajty |
| F05: maska targetu za późno | T09 | Węzły poza targetem nie wymagają danych |
| F06: brak walidacji waveform/activation | T07 | Rust odrzuca nieprawidłowy JSON i stage IDs |
| F07: missing sample udaje outside-domain | T09, T10 | Brak interpolacji nigdy nie jest fizycznym zerem |
| F08: faza FFT | T10 | Structured FFT i direct DFT zgadzają się zespolenie |
| F09: brak zgodnego Inspectora/workflow | T04, T14, T15 | Użytkownik może zbudować i uruchomić antenę bez surowego JSON |
| F10: schema-less DTO i OpenAPI drift | T03, T14 | Wszystkie pięć kolekcji oraz zasoby wyników są typowane |
| F11: nadpisywanie fazy/draftu i transakcje | T15 | Edycja zachowuje pozostałe parametry i pracę użytkownika |
| F12: pozorny lifecycle | T12, T14 | Postęp i anulowanie odpowiadają rzeczywistemu wykonaniu |
| F13: milion par źródło–target | T11 | Preflight, jawny koszt i kwalifikowane wykonanie bez ukrytej redukcji jakości |
| Brak pełnego 3D taper authoring | T04, T06 | Geometria, terminale, siatka i pole zmieniają się fizycznie |
| Brak stage-first Python / ręczne hashe | T03, T12, T13 | Stage/output rozwiązuje runtime; skrypt działa od pustego katalogu wyników |
| FDM i frequency response odrzucone | T16, T17 | Każda ścieżka osobno kwalifikowana albo jawnie unavailable |
| Diagnostyka ważności modelu | T02, T11, T14 | Pasmo i ograniczenia są widoczne przy solve i zmianie waveform |
| Brak fixture `4.5GHz_fem.py` | T01 | Publiczny test ma śledzony, reprodukowalny fixture |
| Cztery błędy source-map 0950 i nieaktualne API | T02, T18 | Pełna dokumentacja bieżącej implementacji i wykonane przykłady |
| Rozjazd z master / brak kwalifikacji | T00, T01, T18 | Udokumentowany wynik integracji, testy mixed mesh/constraints i runtime receipts |

Kolejność podstawowa: `T00 → T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18`. T07 i naprawa zachowania parametrów w T15 mogą być niezależnymi małymi patchami po ustaleniu kontraktu T02. Nie wykonywać równolegle zmian tych samych struktur IR/ABI/sceny.

(plan-governing-equations)=
(plan-symbols-and-si-units)=
(plan-assumptions-and-validity)=
## 2. Decyzje fizyczne i wybór rozwiązania

Równania, symbole i SI pozostają w kanonicznej notatce 0950; audyt wyjaśnia zakres ich poprawności. Plan nie wprowadza drugiego właściciela równań. T02 i T05 uzupełniają tam kontrakt terminali, a T11 diagnostykę pasma i budżetu.

**Porty:** docelowo wybrać integral-current/equipotential przez terminalową macierz przewodności istniejącego solve H1. Alternatywa to dobieranie napięć ręcznie i odrzucanie niezgodnych proporcji. Jest prostsza, lecz nie realizuje obiecanych wag portu i powoduje kłopoty przy zmianie geometrii. Nie zostaje rozwiązaniem docelowym.

**Projekcja:** najpierw naprawić identity+mask, następnie dodać rzeczywiste point location/interpolację P1 oraz możliwość bezpośredniego obliczenia pola na nowych punktach z zachowanego RT0. Bezpośrednia ewaluacja jest dokładniejszą kontrolą błędu próbkowania; interpolacja jest szybsza przy wielu odczytach. Obie mają osobne identyfikatory realizacji i kryteria użycia.

**Zakres EM:** najpierw zamknąć Tier 1. Import zespolonego pola i harmoniczne MQS to osobny późniejszy projekt. Brak pełnego Maxwella nie blokuje przydatnego wzbudzenia LLG; nie wolno jednak użyć tej decyzji jako pretekstu do pominięcia skin/proximity warnings.

(plan-implementation-mapping)=
## 3. Mapa własności plików

`Istniejący` oznacza plik odczytany w audycie; może nadal być nieśledzony przez Git. `Nowy` oznacza proponowany plik, który ma powstać dopiero podczas realizacji.

| Właściciel | Pliki istniejące do zmiany | Nowe pliki planowane |
|---|---|---|
| Fizyka/ADR | `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`, jej source-map, `docs/adr/0017-staged-antenna-field-basis-workflow.md`, `docs/specs/capability-matrix-v0.md`, `docs/specs/problem-ir-v0.md` | Raporty kwalifikacji pod `docs/validation/antenna/` |
| Python | `packages/fullmag-py/src/fullmag/model/antenna.py`, `model/problem.py`, `world.py`, `model/geometry.py`, eksporty `__init__.py` | `packages/fullmag-py/tests/test_antenna_stage_workflow.py`, `test_antenna_layout.py` |
| IR | `crates/fullmag-ir/src/antenna.rs`, `validation.rs`, `plan.rs`, `lib.rs` | `crates/fullmag-ir/src/field_drive_validation.rs` |
| Scena/export | `crates/fullmag-authoring/src/scene.rs`, `builder.rs`, `adapters.rs` | `crates/fullmag-authoring/tests/antenna_roundtrip.rs` |
| Planner | `crates/fullmag-plan/src/antenna_composition.rs`, `antenna_field_solve.rs`, `antenna_projection.rs`, `util.rs`, `spin_transport.rs`, `mesh.rs` | `crates/fullmag-plan/src/antenna_preflight.rs` |
| Native charge | `backends/fem/cpu/mfem/transport/steady_transport.cpp`, `.hpp`, `_c_api.cpp`, `native/include/fullmag_fem.h`, `crates/fullmag-fem-sys/src/lib.rs`, `crates/fullmag-engine/src/fem.rs` | `backends/fem/cpu/mfem/transport/terminal_current_constraints.hpp`, `.cpp`, `backends/fem/tests/antenna_terminal_current_contract.cpp` |
| Native projection | Istniejący właściciel `oersted/direct_tetra_quadrature.*` | `backends/fem/cpu/mfem/transfer/antenna_field_projection.hpp`, `.cpp`, `backends/fem/tests/antenna_field_projection_contract.cpp` |
| Artefakty/runtime | `crates/fullmag-runner/src/antenna_field_solution.rs`, `antenna_stage.rs`, `antenna_fields.rs`, `antenna_spectrum.rs`, `native_fem/charge_transport.rs`, `native_fem.rs` | `crates/fullmag-runner/src/antenna_validity.rs` |
| CLI | `crates/fullmag-cli/src/orchestrator.rs`, `step_utils.rs`, `types.rs` | `crates/fullmag-cli/src/antenna_workflow.rs` |
| API | `crates/fullmag-api/src/schemas/authoring.rs`, `router_v2/handlers/model/authoring.rs`, `router_v2/handlers/data/artifacts.rs`, `router_v2/handlers/data/fields.rs` | `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` |
| Frontend transport | `apps/control-room/src/kernel/api/ControlRoomApi.ts`, `kernel/resources/ResourceInvalidationController.ts`, `kernel/api/generated/openapi-v2*` | `apps/control-room/src/kernel/resources/antennaResources.ts`, `.test.ts` |
| Frontend authoring | `kernel/authoring/geometryLifecycleCommandContributions.ts`, `modules/explorer/builders/objectExplorerNodes.ts`, `modules/ribbon/ribbonContributions.tsx`, `modules/inspector/panels/AntennaObjectPanel*` | Podkatalog `modules/inspector/panels/antenna/` z panelami opisanymi w T15 |
| Gates i scenariusze | `justfile`, `backends/fem/CMakeLists.txt`, `scripts/run_fem_cpu_only_contract.sh`, istniejące skrypty Windows i definicje compose | `scripts/verify_antenna_contracts.sh`, `scripts/windows/verify_antenna_contracts.ps1`, `tests/antenna/`, `apps/control-room/scripts/smoke-antenna-workflow.mjs` |

Nie przenosić całych monolitów tylko z powodu liczby linii. Wydzielić wyłącznie nowe obowiązki antenowe z CLI i numerykę portu/projekcji z wrapperów; zachować sprawdzone istniejące operatory.

## T00. Ustabilizować punkt startowy i integrację z master

**Wejście:** inwentarz 77 plików audytu oraz dwa pełne SHA. **Wyjście:** nazwany snapshot roboczy i dziennik integracji bez utraty zmian.

- [ ] Odczytać `AGENTS.md`, status, staged paths i aktualne SHA. Porównać hashe z inwentarzem raportu; jeśli plik się zmienił, ponownie sprawdzić związany z nim finding przed edycją.
- [ ] Utrwalić wszystkie pliki modułu, również `??`, jako izolowany snapshot. Nie stage’ować całego współdzielonego worktree przez `git add .`; explicit file list ma pochodzić z audytu i statusu.
- [ ] W osobnym worktree integracyjnym połączyć snapshot z master. Nie wykonywać merge/reset/stash nad nieutrwalonymi zmianami innych zadań.
- [ ] Rozwiązać najpierw `plan.rs` i publiczne struktury, następnie konstruktory/adaptery, a na końcu execution. W `project_regional_field_drive_bases` zachować jednocześnie branch preprojected i kontrole mixed-mesh z master.
- [ ] Utworzyć `docs/validation/antenna/integration-baseline.md` z SHA, listą konfliktów, decyzjami i wynikami bazowych testów. Commit integracji nie może zawierać późniejszych poprawek fizyki.

Polecenia diagnostyczne wykonywać oddzielnie:

```powershell
git status --short
git diff --cached --name-only
git rev-parse HEAD master
git merge-base HEAD master
git diff --name-only HEAD master
git diff --check
```

**Test zamknięcia:** żaden z 77 audytowanych plików nie zniknął bez udokumentowanej migracji; mixed-mesh global uniform i frozen-spins regression z master pozostają w zestawie uruchamianych testów.

## T01. Przygotować powtarzalne bramki i naprawić fixture testowe

**Pliki:** `justfile`, `scripts/run_fem_cpu_only_contract.sh`, nowe dwa skrypty verification z mapy, `packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py`; nowy `packages/fullmag-py/tests/fixtures/gaussian_plane_wave_fem.py`.

- [ ] Utworzyć recipe **nowe** `verify-antenna-contracts group="all"`. Przyjmuje wyłącznie grupy z poniższej listy; nie przyjmuje dowolnego tekstu polecenia shell.
- [ ] Wykorzystać istniejący container entrypoint. Na Windows użyć Docker Desktop Linux engine i walidacji bezwzględnych zewnętrznych rootów ze skryptów Windows; bez named volumes, WSL exec i lokalnego `target/`.
- [ ] Zdefiniować wewnątrzkontenerową listę programów/testów dla każdej grupy. Host nie wywołuje bezpośrednio natywnego Cargo/CMake. Grupa ma zwracać błąd, jeśli filtr uruchomił zero wymaganych testów.
- [ ] Wszystkie wyniki zapisywać do zewnętrznego katalogu raportu z commit SHA, hashami dirty źródeł, komendą, exit code, liczbą testów i urządzeniem. Skipped GPU oznacza `not_qualified`, nie PASS.
- [x] Odtworzyć brakujący fixture na podstawie oczekiwań `test_fem_counterpart_preserves_geometry_gradient_and_antenna_contract`: zachować FEM, geometrię, gradient i parametry GaussianPlaneWave. Przenieść test na śledzony fixture w pakiecie. Nie usuwać asercji i nie oznaczać testu skip tylko dlatego, że prywatny `tests/vlad` nie jest dostępny.
- [ ] Uruchomić dotychczasowe cztery suites Python i bazowe bramki `just`; zapisać rzeczywiste wyniki przed dalszą implementacją.

Wartości grup nowego recipe:

```text
model
authoring
native-current
native-field
artifact
projection
spectrum
budget
lifecycle
fem-llg
fdm-cpu
fdm-gpu
fem-gpu
frequency-response
browser
all
```

Istniejące polecenia, od których należy zacząć:

```text
just --dry-run verify-fem-charge-transport-abi-contract
just verify-fem-charge-transport-abi-contract
just verify-fem-solved-antenna-drive-contract
just verify-fem-oersted-oet0-cpu-contract
```

Po dodaniu wrappera pozostałe zadania używają `just verify-antenna-contracts <grupa>`. Każde takie polecenie w planie jest **nowym kontraktem do wykonania T01**, nie istniejącym dowodem działania.

**Weryfikacja części Python, 2026-10-03:** śledzony fixture
`packages/fullmag-py/tests/fixtures/gaussian_plane_wave_fem.py` istnieje, a
test jego kontraktu przeszedł. Sześć suites (`gaussian_plane_wave_antenna`,
`antenna_layout`, `antenna_composition_contract`, `antenna_stage_workflow`,
`current_transport`, `runtime_cli_state_transfer`) uruchomiono przez `python -m pytest -q -rs -p
no:cacheprovider` w izolowanym venv pod kanonicznym storage D:; wynik:
**68 passed, 2 subtests passed, 0 skipped**, exit code 0. Wcześniejszy
`TypeError` w teście legacy maski wynikał z brakującego argumentu
`overrides={}` prywatnego renderera; test poprawiono bez zmiany migracji
`prescribed_zeeman_mask` do regionalnego drive. HEAD:
`f250ce991cf551331e089670dbe3696918e27835`; bieżące hashe blobów
testu `test_current_transport.py`, fixture i `script_builder.py`:
`7e37f1a7b9d2c64bcd478e236b9ee487e520b6e8`,
`6ad7ca08c084e8f4de763aebfdf4f0ad8c0fecec`,
`1f2e033f4f44aa146557f781a9120c66039d90c5`. Nie jest to
bramka kontenerowa T01 ani dowód testów Rust/natywnego FEM; pozostałe grupy
nadal są otwarte.

**Wrapper kwalifikacji, 2026-10-03:** `just verify-antenna-contracts
authoring` uruchamia sześć powyższych suites i zapisuje `result.json`,
`test.log` oraz tożsamość źródeł pod zarządzanym katalogiem
`D:/git/fullmag/storage/runs/.../antenna-contracts/`. Wynik: **68 passed,
2 subtests passed, 0 skipped**, exit code 0; raport:
`20261002T235951530191Z-fbe519db`, source snapshot
`f1e00a26a657778da47013f29dd7ce160d7c7f35ae90383e1e5dcb55f1c82d96`.
Regresje wrappera sprawdzają też błąd uruchomienia interpretera i błąd
ponownego capture źródeł: zapisują `fail`, raport i kod 3; sześć testów
wrappera przeszły. Dodatkowe dwa testy Python dotyczą granicy rzeczywistego
końca Relax → początku Run i odmowy transferu FEM→FDM bez kanonicznej
tożsamości siatki; nie dowodzą natywnej trajektorii LLG.
Lista 16 grup jest zamknięta. Kontrolne `native-current` zapisuje raport
`20261002T234917834471Z-279a2ee6` ze stanem `not_qualified` i kończy się
kodem 3, ponieważ nie ma jeszcze mapowania na kwalifikowany test w
kontenerze. Recipe nie spełnia jeszcze całej bramki T01: grupy natywne,
GPU i `all` wymagają mapowań na kontener i dowodów, a grupa `browser`
realnego smoke przeglądarkowego oraz kwalifikacji runtime.

**Lekka bramka UI, 2026-10-03:** `just verify-antenna-contracts browser`
uruchamia śledzony test Node TAP i dziesięć suites Vitest. Raport
`20261003T002356605232Z-36d2896b` zapisuje **72/72 passed, 0 failed,
0 skipped**, kody obu komend 0, niezmienność źródeł i snapshot
`c8a5bbece819860d063abb8255cff46a354ccc0d31a4f55a2f7c75c176b918e0`.
Stan raportu pozostaje `not_qualified`: testy DOM/modelu nie zastępują
rzeczywistego browser E2E z WebGL, API i zarządzanym solverem.

**Przygotowanie trasy natywnej, 2026-10-03:**
`scripts/run_fem_cpu_only_contract.sh` nie usuwa już rekurencyjnie
zarządzanego katalogu builda przed uruchomieniem; ponowna konfiguracja używa
`cmake --fresh` (obraz `fem-cpu` deklaruje CMake 3.30.5). Skrypt wymaga
zarządzanych `FULLMAG_FEM_CPU_BUILD_ROOT` i `FULLMAG_RUNTIME_ROOT`, bez
fallbacku do `/tmp`. `bash -n` przez Git Bash, 17 testów źródłowych audytu
CPU-only oraz `just --dry-run` recept charge ABI i OET0 przeszły.
Nie jest to wykonanie natywnego kontraktu ani dowód izolacji równoległych
uruchomień. `runner-container-status` nadal zgłasza brak konfiguracji.

## T02. Zamknąć fizyczny kontrakt portów i migrację

**Pliki:** 0950 i source-map, ADR 0017, capability matrix, `crates/fullmag-ir/src/antenna.rs`, `packages/fullmag-py/src/fullmag/model/antenna.py`.

**Decyzja:** gałąź ma dwa jawne terminale i kierunek od inlet do outlet. Dodatnia waga oznacza prąd zgodny z tym kierunkiem. Współrzędne świata i lokalna orientacja muszą być zapisane; nie wnioskować kierunku z nazwy `signal` ani numeru markera.

- [ ] Zastąpić niejednoznaczną pojedynczą referencję terminalu **nowym wersjonowanym** kontraktem gałęzi. Nie zmieniać interpretacji starych zapisanych JSON w miejscu.
- [ ] Wprowadzić dokładnie pola poniższego projektu. Wagi dodatnie muszą sumować się do 1, wszystkie do 0; każda gałąź ma niezerową wagę, dwa różne niepuste selektory i dodatnie pole terminali. Sprawdzić, że terminale należą do wskazanego przewodnika i są elektrycznie sensowne.
- [ ] Nadać portowi discriminator `schema_version="antenna_port_mode.v2"`. W bieżącym kanonicznym `AntennaPortModeIR.branches` używać `AntennaPortBranchV2IR`; stare dekodowanie wyizolować w importerze. Brak discriminator w starym dokumencie nie uprawnia do odgadnięcia par terminali.
- [ ] Zaktualizować port/stage/plan tak, aby przenosiły tę samą parę terminali, a nie redukowały jej z powrotem do pojedynczego ID.
- [ ] Stary kontrakt z jednym terminalem zachować wyłącznie w importerze compatibility. Jeśli nie ma jednoznacznej pary i zamknięcia, zwrócić `antenna_port_migration_requires_terminal_pairs`. Nie wybierać „drugiej ściany” heurystycznie.
- [ ] Rozdzielić definicję portu od ConservativeCurrentView: pierwszy ustala wymuszenie i orientację, drugi przechowuje zachowawczy prąd oraz zamknięcie. Sprawdzać zgodność obu; suma wag nie zastępuje dowodu zamknięcia.
- [ ] Dodać negatywne testy obu wersji IR: powtórzone terminale, brak powrotu, nieznany obiekt, niezgodne domain, suma dodatnia 2 zamiast 1, zero, NaN, pusty ID.

Projekt nowego typu, do zadeklarowania w T02:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaPortBranchV2IR {
    pub id: String,
    pub inlet_terminal_ref: String,
    pub outlet_terminal_ref: String,
    pub signed_weight: f64,
}
```

Nie dodawać jednocześnie kopii geometrii, przewodności ani materiału do tego typu. Dla CPW stosować trzy gałęzie `(1, -0.5, -0.5)`, każdą z własną parą końców. `normalization_current_a` pozostaje dokładnie 1 A.

**Bramka:** `just verify-antenna-contracts model`. Błędne porty mają być odrzucone w modelu, zanim powstanie natywny solver. Dokumentacja otrzymuje kompletną tabelę nowych parametrów z SI i mapowaniem Python → IR; wszystkie zmiany publiczne pozostają oznaczone jako niekwalifikowane do T18.

## T03. Zachować model w SceneDocument, builderze i Python stage API

### Checkpoint 2026-10-07 — deklaracje nie są aktywnymi etapami

Rzeczywista scene5 ma port=1, solve=1, projection/drive/spectrum=0 oraz
`study_pipeline=null`. Eksport nie może wyprowadzić action z obecności
definicji. Wymagane rozdzielenie całego typowanego authoring inventory od
execution state opisuje nota 0950 +
`DOC-ANCHOR:antenna-authoring-inventory-execution-separation`.
Samo pominięcie CapturedStage przy dopisaniu drive do Problem jest błędne:
loader usuwa tylko scheduled IDs, a Rust zachowuje unscheduled drive.

- [ ] Wdrożyć typowany owner deklaracji i zachować pełne inventory w workspace/capture/scenie; bez runtime_metadata blobu, bez wymuszania enabled=False.
- [ ] Oddzielić każdy Run/Relax oraz root execution IR od nieaktywnych deklaracji; zachować legacy publiczny aktywny workflow bez cichej migracji.
- [ ] Udostępnić samodzielną deklarację projekcji bez fikcyjnego drive; jawna aktywacja identycznego ID/payload bez duplikacji, konflikt atomowy.
- [ ] Odebrać definitions-only i mixed active/declaration round-trip przez bootstrap/override/final export oraz rzeczywistą scene5, bez pomijania kolekcji.
- [ ] Odebrać declaration→Run, Run→activation→Run, przyszły drive po wcześniejszym Run, dangling refs, kolejność etapów i nieaktywność pola w managed runtime.

Po read-only trace wdrożono źródłowe WIP `AntennaAuthoringInventory`, cztery
keyword-only metody `StudyBuilder.declare_*` i deklaracyjny renderer.
11 interpretowanych regresji inventory oraz 11 identity PASS obejmują
capture/export/reimport i izolację snapshots bez solvera. Pełna scene5
przechodzi dawne blokady ID i braku actions, lecz zawiera niepoprawne
`target_refs=[]` i jest odrzucana przez publiczny Python. Nowa komenda UI
tworzy jawny globalny target (commit
`539b8e942e7f30b512b458971d76b7711ad5ece4`), istniejących definicji nie
naprawia automatycznie. Full authoring provenance w runtime, disabled/macro
pipeline, rzeczywisty pełny round-trip i managed wykonanie pozostają
nieodebrane; powyższe checklisty nadal otwarte. T03 i cały T00–T18 nie są
ukończone. Nota 0950/mapa źródeł z czterema kompletnymi parametrami API
przeszły focused publication validator; nie jest to runtime proof.

**Pliki:** `scene.rs`, `builder.rs`, `adapters.rs`, API schema/authoring handler, `model/problem.py`, `world.py`, istniejący test composition; nowe `antenna_roundtrip.rs` i `test_antenna_stage_workflow.py`.

**Wejście:** wersjonowane typy port/stage/projection/drive/spectrum. **Wyjście:** scena i builder przechowują wszystkie kolekcje, a publiczny workflow nie wymaga ręcznego JSON ani hashy.

- [ ] Najpierw dodać test RED rzeczywistego `apply_scene_merge_patch`: scena minimalna + pięć niepustych kolekcji → deserializacja → serializacja. Oczekiwać zachowania każdego ID; obecny kod zgubi dane.
- [ ] Dodać typowane pola do `SceneDocument` i `ScriptBuilderState`, wraz z serde default dla starych scen. Te same typy wykorzystać w `SceneResource`, bez `Vec<Value>`.
- [ ] Przenieść kolekcje we wszystkich kierunkach adapterów, także eksport/import i rewrite overrides. Nie wystarczy adapter tylko scene → DTO.
- [ ] W `world.py` dodać **nowe** metody `StudyStagesBuilder.add_antenna_field_solve` i `StudyBuilder.add_solved_antenna_drive` z dokładnie określonymi argumentami poniżej. Rejestracja solve zwraca symboliczną referencję stage/output, nie już istniejący digest.
- [ ] Wytworzyć pipeline node o istniejącym zamiarze `antenna_field_solve`; nie tworzyć drugiej listy etapów o odrębnej kolejności. Uporządkować relację `StudyIR` i `StudyPipelineDocument` w ADR 0017.
- [ ] Lowering do runnera zachowuje requested execution oddzielnie dla precompute i późniejszego LLG. Wersja authoring reference nie zawiera fizycznych ścieżek lokalnych.
- [ ] Dodać test API transakcji → GET → export → loader → IR, korzystając z rzeczywistej warstwy authoring zamiast mocka `commitTransaction`.

Pola do włączenia w kanonicznych właścicielach, z finalnymi wersjami typów T02:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_port_modes: Vec<fullmag_ir::AntennaPortModeIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_field_solve_stages: Vec<fullmag_ir::AntennaFieldSolveStageIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_target_projections: Vec<fullmag_ir::AntennaTargetProjectionRefIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub solved_antenna_drives: Vec<fullmag_ir::SolvedAntennaDriveIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_spectrum_requests: Vec<fullmag_ir::AntennaSpectrumRequestIR>,
```

Projekt publicznych argumentów nowych metod:

| Metoda | Argumenty | Wynik |
|---|---|---|
| `study.stages.add_antenna_field_solve` | keyword-only `id: str`, `definition: AntennaFieldSolveStage` | `AntennaStageOutputRef` z `stage_id`, `output_id`; zgłosić błąd, gdy brak dokładnie jednego żądanego H_ant_basis output |
| `study.add_solved_antenna_drive` | keyword-only `drive: SolvedAntennaDrive`, `projection: AntennaTargetProjection` | Zarejestrowany drive; ID musi być unikalne |

Nowy `AntennaStageOutputRef` to authoring intent. `AntennaFieldSolutionRef` z asset/digest pozostaje resolved reference po wykonaniu. T08/T12 definiują ich kontrolowane rozwiązanie; nie udawać, że hash pierwszego solve można znać podczas pisania skryptu.

Definicja nowej referencji authoringu w `model/antenna.py`:

```python
# %% Projekt nowego typu do wdrożenia w T03; bez wykonywania solve
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class AntennaStageOutputRef:
    stage_id: str
    output_id: str

    def __post_init__(self) -> None:
        if not self.stage_id.strip() or not self.output_id.strip():
            raise ValueError("stage_id and output_id must be non-empty")

    def to_ir(self) -> dict[str, str]:
        return {
            "kind": "stage_output",
            "stage_id": self.stage_id,
            "output_id": self.output_id,
        }
```

`AntennaTargetProjection.solution` ma podczas authoringu przyjmować tę referencję; resolved plan zawiera istniejącą pełną `AntennaFieldSolutionRefIR`. Dla jawnie zaimportowanych gotowych assetów dopuścić drugi discriminator `kind="resolved_asset"` i sprawdzanie T08. W scenie zachować autorską symboliczną referencję, nie zastępować jej trwale hashami po każdym runie. Golden tests mają chronić oba typy referencji i eksportować je bez utraty intencji.

**Bramka:** `just verify-antenna-contracts authoring`; Python tests stage workflow muszą przejść także na scenie bez anten i na imporcie starego regional drive. Commit: `fix: preserve antenna composition through scene round trips`.

## T04. Dokończyć rzeczywistą geometrię 3D i jej wygodne tworzenie

**Pliki:** istniejący `model/geometry.py`, `model/antenna.py`, odpowiednie geometry variants w IR, `crates/fullmag-plan/src/mesh.rs`, frontendowa komenda; nowe `test_antenna_layout.py` i `tests/antenna/scenarios/cpw_constriction.py`.

- [ ] Umieścić opis stacji szerokości jako parametr współdzielonej geometrii, nie w `SolvedAntennaDrive`. Port odwołuje się do obiektu z tą geometrią.
- [ ] Zdefiniować dla microstrip: długość, grubość, ordered stations `(s, signal_width_m)` i jawny obiekt return. Dla CPW: station posiada także left/right gaps oraz ground widths. `s` jest bezwymiarowe, od 0 do 1.
- [ ] Walidować skończoność, ścisły porządek, końce 0/1, dodatnie wymiary, brak nakładania metalu, niezerowe end faces i zgodność terminali po transformacji.
- [ ] Generować skończone bryły 3D i markery inlet/outlet ze wspólnego geometry pipeline. Nie tylko rysować taper w Three.js. Stacje wyznaczają piecewise-linear loft; rigid transform stosuje się do wszystkich przewodników i terminali razem.
- [ ] Tworzyć `object_id` raz; edycja nazwy lub geometrii nie nadaje nowego ID. Zmiana geometrii podbija geometry revision i podpisy zależności T08.
- [ ] Domyślny kreator ma tworzyć komplet sygnał + returns + terminal pairs + current module + port; brak targetu oznacza `incomplete`, nie `ready`. Nie dodawać automatycznie magnetyzacji do miedzi.
- [ ] Testować eksport parametrów, nie tylko triangulacji; po export/reimport użytkownik nadal może edytować stacje.

Fixture geometrii do zamrożenia w teście:

Checkpoint 2026-10-07 — rzeczywista scena UI rewizji 6 ujawnia niezależne
blokady pomiędzy authoringiem i solve. `geometry.rs::validate_object_geometry`
w `crates/fullmag-authoring/src/` wymaga material/magnetization refs dla każdego
obiektu, również niemagnetycznego microstrip. `material_requirements.rs::scene_solve_objects`
oraz `validation.rs::validate_scene_document` stosują natomiast podział po role.
Nie naprawiać tej rozbieżności przez wyjątek „pomijaj antenę” ani dopisanie Ms/Aex.
Wymagany wspólny kontrakt jawnie zadanej fizyki, osobna walidacja każdej podanej
referencji i jawna migracja legacy; brak naprawy lub odbioru runtime w tym checkpointcie.
Pozostawić transform/backend/geometry guards: live `GEOMETRY_KIND_UNSUPPORTED`
dla `MicrostripAntennaLayout` w FDM jest oddzielną blokadą.
Fabryka `geometryLifecycleCommandContributions.ts::defaultMicrostripCurrentTransport`
opisuje terminale, ale nie tworzy mesh-exact view ani typed current-source input.
Nazwa `:current:rt0` nie jest wynikiem przygotowania siatki/prądu. T04→T05/T06
wymaga rzeczywistego producenta, zgodnych terminali i geometry revision binding.
`crates/fullmag-plan/src/antenna_field_solve.rs::plan_antenna_field_solve_execution` rozdziela
unqualified external-lead inspection od field basis; nie promować inspection
do projection/drive/FFT. Dowody i dokładne pozostałe bramki:
`storage/tmp/<worktree-id>/current-source-oracle/antenna-scene6-solve-blockers-20261007.md`.

```json
{
  "length_m": 0.00001,
  "thickness_m": 0.0000001,
  "stations": [
    {"s": 0.0, "signal_width_m": 0.000001},
    {"s": 0.4, "signal_width_m": 0.000001},
    {"s": 0.48, "signal_width_m": 0.0000002},
    {"s": 0.52, "signal_width_m": 0.0000002},
    {"s": 0.6, "signal_width_m": 0.000001},
    {"s": 1.0, "signal_width_m": 0.000001}
  ]
}
```

Powyższy JSON jest specyfikacją testowego kształtu, nie deklaracją obecnego top-level konstruktora. CPW test dopisuje jawne stałe dodatnie gap/ground widths w każdym wierszu. Wymagać trzech przekrojów: szeroki, wejście taperu, przewężenie, oraz tego samego wolumenu po obrocie.

**Bramka:** `just verify-antenna-contracts model` i `authoring`. Test pola po zmianie stacji należy do T06; test samej bryły nie kwalifikuje current crowding.

## T05. Wykonać integral-current i naprawić znak normalizacji

**Korekta certyfikatu 2026-10-03:** końcowy residual słabej reakcji jest
porównywany z modułem żądanego prądu **tego samego zacisku** według równania
`antenna-terminal-current-certificate` w nocie 0950. Skala największego
prądu w całym porcie ani nawet w jego spójnej składowej może zaakceptować
odwrócenie bardzo małego returnu; nie jest prawidłowym certyfikatem znaku.
Kod C++ i kontrola Rust zostały zaostrzone, a regresja Rust obejmuje return
`1e-13 A` przy sygnale `1 A`. Regresja nie została wykonana przez zakaz
kompilacji testów jednostkowych; pełny build runnera o digestcie
`703e6ad15010a1ae026dd2792a5327b15df1543d200699c9ae1d9e1bef91b0e3`
poprzedza tę korektę i jej nie weryfikuje.
Build snapshotu zawierającego korektę, job
`4204fc0ca6474de7b6c66dd6462ed217` (digest
`82ed781d4c29c54a0047147434a470d23f63a841d0d5c13d91375472d629dd27`),
zakończył się `succeeded`, exit 0: native build, zależności frontendu i
frontend build mają exit 0, a receipt deklaruje 109 kompletnych artefaktów.
Receipt ma `qualification: NOT VERIFIED`; nie zastępuje uruchomienia
zakazanych obecnie testów jednostkowych ani bramki natywnego runtime T05.

**Pliki:** nowe native `terminal_current_constraints.*`, istniejący steady transport i ABI, sys/engine wrappers, planner binder i runner `measured_port_current`; nowy native contract test.

**Zależność ujawniona 2026-10-01 (przykład publiczny T18):** bieżący
`AntennaFieldSolveStage.conservative_current_view_ref` jest autorskim
łańcuchem, lecz `bind_resolved_antenna_field_solve` wymaga już w planie
`charge.fem_cpu_double.conservative_current_view = Some(...)`. Publiczny
`ConservativeCurrentView` zawiera identyfikatory wierzchołków, ściany,
tożsamość siatki oraz piny rewizji. Nie ma dziś dowodu, że zwykły skrypt
`fm.study(...).stages.add_antenna_field_solve(...)` może wygenerować ten
widok z geometrii przed meshingiem i wykonać solve bez ręcznie wpisanych
identyfikatorów konkretnej siatki. Testy stage-first potwierdzają authoring,
referencje symboliczne i round-trip, ale nie uruchamiają natywnego solve.
Przed publikacją skryptu 0950 jako wykonywalnego end-to-end T05/T12 muszą
udostępnić jawny, zweryfikowany mechanizm tworzenia i wiązania konserwatywnego
widoku po meshingu oraz jego provenance; alternatywnie przykład musi jawnie
korzystać z wcześniej utworzonego, zgodnego artefaktu i testować jego piny.
Nie należy zastępować tej luki fikcyjnym `cpw_closed_current_view` ani
`fm.AntennaFieldSolve` z dawnego szkicu 0950.

**Algorytm docelowy:** korzystać z liniowości H1 i terminalowej macierzy przewodności. Dla każdej składowej elektrycznie spójnej nadać jeden gauge, wyznaczyć reakcje terminalowe dla niezależnych jednostkowych potencjałów, rozwiązać mały układ terminalowy dla zadanych podpisanych strumieni, a potem odtworzyć potencjał i prąd przestrzenny. Nie pisać drugiego solve FEM w Rust.

- [ ] W teście jednostkowym portu pokazać RED: przy wagach `(1,-0.5,-0.5)` certyfikat nie może akceptować wszystkich kombinacji znaków tych samych modułów prądu. Test dotyczy jawnie zdefiniowanych outward flux na outletach.
- [ ] Dla każdej gałęzi wyznaczyć `I_in = -weight A`, `I_out = +weight A`. Sprawdzić bilans wszystkich terminali każdej składowej spójnej; izolowana składowa bez wymuszeń nie może powodować singular solve.
- [ ] Złożyć terminal response matrix przy equipotential na każdej ścianie. Reakcje mają pochodzić z tego samego dyskretnego operatora co solve, nie z niekwalifikowanego postprocessingu gradientu w narożnikach.
- [ ] Usunąć gauge row/column albo użyć jawnego constraint; wykrywać rank deficiency i niespójny net current przed iteracją. Nie stosować arbitralnej regularizacji macierzy, aby „przeszło”.
- [ ] Odtworzyć V/J dla całego portu i sprawdzić podpisany residual każdego terminalu oraz globalny bilans. Zmiana conductance returns ma zmieniać wymagane napięcia, a nie łamać autorskich wag.
- [ ] Przekazać żądanie przez nową wersję ABI z `struct_size` i `abi_version`. Zachować istniejące V1/V2 entrypoints; przed wyborem kolejnej wersji sprawdzić aktualny master. Nie reinterpretować starych wskaźników/struktur.
- [ ] `measured_port_current` zastąpić podpisanym certyfikatem: brać prąd referencyjny z ustalonej dodatniej orientacji i dokładnie jednej strony gałęzi. Nie sumować obu końców i nie naprawiać błędnej orientacji przez `abs()`.
- [ ] Zapisać requested currents, measured currents, gauge per component, terminal voltage i wersję solvera w proweniencji. Przeskalowanie do 1 A musi objąć V, J i H, zachowując znak.

Logika podpisanej kontroli, do włączenia po rozwiązaniu terminali:

```rust
fn terminal_flux_matches(measured: f64, expected: f64, atol: f64, rtol: f64) -> bool {
    measured.is_finite()
        && expected.is_finite()
        && (measured - expected).abs() <= atol + rtol * expected.abs()
}

#[test]
fn signed_terminal_flux_rejects_reversed_return() {
    assert!(terminal_flux_matches(-0.5, -0.5, 1e-12, 1e-8));
    assert!(!terminal_flux_matches(0.5, -0.5, 1e-12, 1e-8));
}
```

Tolerancje w tej funkcji są specyfikacją certyfikatu dla 1 A, nie ogólną tolerancją trajektorii. Dodać affine bar, asymetryczne returns, odwrócenie całego portu, rozłączne przewodniki, gauge invariance i podwójny prąd. **Bramka:** `just verify-antenna-contracts native-current` oraz dotychczasowy charge ABI contract. Commit: `fix: enforce signed antenna terminal currents`.

## T06. Zweryfikować prąd konserwatywny i pole 3D

**Blokada integral-current → RT0 (audyt źródeł 2026-10-03):**
`execute_native_fem_charge_transport` publikuje V/J i prąd normalizacji
z `solve_native_fem_charge_transport`, lecz H bierze z niezależnego
`solve_native_fem_steady_transport_rt0`. Native `solve_rt0` dla closed
geometry rozwiązuje periodic charge sterowany napięciem source cut;
external lead rozwiązuje osobną połączoną domenę z napięciem zewnętrznym.
Przekazane napięcia H1 nie wiążą tych solve'ów. Zmiana napięcia closure
przy tym samym porcie może zmienić H bez zmiany publikowanych V/J
i normalizacji. Jest to wniosek z kodu, nie wykonana regresja runtime.
Bilans RT0 nie jest certyfikatem zgodności z żądanymi prądami portu.
Samo dzielenie H przez prąd odczytany z RT0 nie naprawia wspólnego V/J/H.

Domknięcie obowiązkowe przed kwalifikacją T05/T06:

Stan kroku przygotowawczego (2026-10-03): native `ConservativeCurrentView::Build`
zachowuje własne węzłowe V z charge solve prowadzącego do RT0 oraz stable IDs;
external obejmuje device+leady. Import samego RT0 nie fabrykuje potencjału.
Dodano źródłowe regresje własności i analitycznego V w trzech istniejących
testach kontraktu. Nie zostały skompilowane ani uruchomione ze względu na
obowiązujący zakaz kompilacji testów. Początkowy krok nie eksportował payloadu
przez ABI, broadcast MPI ani producenta artefaktu. Dotychczasowe dwa aktywne
zgłoszenia buildu powstały przed tą zmianą; nie stanowią jej weryfikacji.
Validator noty 0950: exit 0; testy kontraktu dokumentacji: 32/32; kontrola diff:
bez błędów. Te kontrole nie kwalifikują numeryki ani runtime T05/T06.
Pełny build nowego snapshotu przyjęto do istniejącej kolejki:
`9a47e3713ca444e9ba05599af7fc331f`, profil `fem-cpu-release`, request
`antenna-t06-owned-charge-potential-20261003`, source digest
`46965f01db918624d7ac445b95bde842ed323a0d2d504aff36fbd210c72980de`.
Stan przy odczycie: `queued`, brak exit code. Nie jest to jeszcze dowód
kompilacji ani uruchomienia nowego payloadu.

Kolejny krok źródłowy (2026-10-03): nowy wynik pomocniczy ABI
`fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1` oraz trzy symbole
`*_with_charge_snapshot_v1` eksportują V/stable IDs/xyz z tego samego native
view, co RT0/OE-F1/OE-F2. Wszystkie stare layouty i entrypointy pozostają
bez zmian. Nowe długości są publikowane po pełnym sukcesie, a błędy zerują
oba wyniki; bufory po błędzie nie są przeznaczone do odczytu. Test ABI
rozszerzono o analityczne V, wspólny digest, błędne pojemności, nagłówki i null.
Rust FFI zawiera odpowiadający layout i deklaracje; parser Rust: exit 0.
Nie wykonywano kompilacji ani testu ABI. Runner jeszcze nie odczytuje payloadu;
nie zmieniono publikacji mieszającej dwa solve'y ani wymuszenia port-current.
Build `9a47e3713ca444e9ba05599af7fc331f` nie zawiera zmian ABI. Pełny build
tej granicy należy zlecić wraz z podłączeniem konsumenta, bez utożsamiania
wcześniejszego snapshotu z bieżącym kodem. Bramka T05/T06 pozostaje otwarta.

Podłączenie adaptera Rust (2026-10-03):
`solve_native_fem_steady_transport_rt0` wywołuje nowe ABI dla RT0 i obu metod
pola, również przy `target_points=None`. `NativeFemChargePotentialSnapshot`
przechowuje pełne V/IDs/xyz device+lead; kontrola wymaga dokładnych długości,
kolejności siatki, skończoności, unikalnych IDs, wersji oraz raw 64-lowerhex
digestu równego RT0. Bufory V/xyz inicjalizuje NaN. Pojemności RT0 i OE-F2
uwzględniają wszystkie leady i sprawdzaną arytmetykę; lokalny preflight OE-F1
liczy wszystkie tetraedry źródła. Dodano źródłowy test walidatora i oracle V
do istniejącej regresji coupled external lead. Parser Rust, validator noty
i kontrola diff przeszły; testów natywnych nie kompilowano. To nadal nie
naprawia publikowanego V/J, normy per ampere, sterowania port-current ani
projekcji nodalnego H z combined domeny OE-F2 na target. Te bramki pozostają
obowiązkowe przed uznaniem T05/T06 za wykonane.

Checkpoint buildu ABI+adaptera: job `83d0f399849740139ba93ccc96f29d83`,
profil `fem-cpu-release`, request
`antenna-t06-charge-snapshot-abi-consumer-20261003`, source digest
`1136a6ebc844f5169b220f590bdff164c9d71b4cd9f8af8f221529c596c0cff1`,
capture `b9d4f64b074546f188ccae2ab991425c`, native source identity
`3d2d541f4adbcbb7caf790f1ecf5c41366bc46ba93b99c58f2f926b5e649eca0`.
Stan: `queued`, brak exit code; snapshot zawiera nowe ABI i adapter, nie
ten późniejszy wpis statusu. Zastępuje oczekujące stare snapshoty
`4842951a463d49739094156b30fb5af2` i `9a47e3713ca444e9ba05599af7fc331f`,
które potwierdzono jako `cancelled`; nie usuwano ich artefaktów. Aktywny
`2f42f7bf46464bc18bb76345de081ca1` pozostał `running` i nie był przerywany.
Validator noty: exit 0; kontrakt dokumentacji: 32/32; parser Rust: exit 0;
kontrola diff: bez błędów. Brak dowodu kompilacji aktualnego ABI, runtime
i fizycznej zgodności port-current; żaden checkbox kwalifikacji nie awansuje.

Dalsze źródłowe ustalenie T05/T06: periodic native ma jednocutowy geometryczny
lift i jeden gauge pin. Weighted RT0 KKT zawiera wiersze div=0 oraz bilansu
par, ale nie podpisane aggregate terminal-current constraints. Same
`terminal_faces` zwalniają terminale z izolacji. Wdrożenie musi zachować
nieeliminowane reakcje H1 jako kanoniczny certyfikat portu, dodać zgodny
wielocutowy trace lift i gauge per komponent po quotient, a do rekonstrukcji
RT0 jawne sumy strumieni terminalowych wraz z analizą rzędu i niezależnym
pomiarem po solve. Nie dopasowywać wyłącznie napięcia closure do strumienia
RT0 i nie poprawiać wyłącznie dzielnika H. Stan: wymagane, niezaimplementowane.
Legacy `max_paired_weak_flux_mismatch_a` w periodic solverze pochodzi z
kwadratury normalnego gradientu V, nie z reakcji H1; nie może zastąpić
kanonicznego podpisanego certyfikatu portu. Rozróżnić equipotential terminal
od trace-jump actuator i sumować tylko jedną orientowaną stronę cutu.

Aktualizacja obserwacji kolejki: `2f42f7bf46464bc18bb76345de081ca1`
zakończył się `succeeded`, exit 0; receipt zawiera trzy etapy z exit 0,
ale `qualification=NOT VERIFIED`. Jego snapshot poprzedza aktualne ABI.
`83d0f399849740139ba93ccc96f29d83` przeszedł do `running`; potwierdzono
żywy proces `cargo`/`rustc` w `fullmag-worker-83d0f399849740139ba93ccc96f29d83`.
Nie jest to jeszcze sukces nowej kompilacji ani dowód runtime anteny.

1. Utworzyć jeden native zaakceptowany charge snapshot pełnej domeny 3D
   przewodnika i autorskiego closure, sterowany podpisanym portem.
   Wykorzystać istniejące operatory MFEM i algorytm odpowiedzi terminalowej.
2. Z tego snapshotu uzyskać V, jawnie zlokalizowane J, podpisane prądy
   i RT0; z tego samego RT0 obliczyć H. Append-only ABI ma przenieść wspólną
   accepted-source identity i wyniki, bez zmiany starych entrypointów.
3. Antenowy runner musi usunąć niezależny wcześniejszy H1 solve i publikować
   wyłącznie wspólny wynik. Numeryka pozostaje w native workflow wskazanym
   w masterplanie backendu §7.3, nie w Rust.
4. Dla wielu niezależnych cutów rozwiązać rzeczywistą macierz odpowiedzi
   cut/terminal→prąd; obecny jeden source cut nie realizuje zadanych
   niezależnych returnów CPW. Po meshingu materializować closure selectors,
   stable IDs, role i pary ścian oraz rzeczywiste hashe. Sam string
   `conservative_current_view_ref` nadal nie ma resolvera w plannerze.
5. Weryfikować wspólne pochodzenie V/J/H, faktyczne prądy RT0 z prawidłową
   orientacją outward (nie surową sumą canonical flux), skalowanie 1/2/−1 A,
   gauge, asymetryczne returns i trzy poziomy siatki taperu. Regresja
   producenta ma zmieniać wyłącznie napięcie closure przy stałym porcie.

Zaostrzenie kontroli manifestu i zielony build nie domykają tej blokady.

Checkpoint kontraktu matematycznego T05/T06 (2026-10-03): nota 0950,
`DOC-ANCHOR:antenna-accepted-charge-workspace`, zawiera teraz jawne
wyprowadzenie affine trace $V=Q u+L d$, redukcji H1, odpowiedzi podpisanych
reakcji terminalowych oraz weighted RT0 KKT z prądami terminalowymi.
Zdefiniowano symbole i jednostki, zgodność cykli relacji DOF, gauge tylko
dla niezakotwiczonych komponentów, brak automatycznego utożsamienia
trace-jump reaction z prądem terminala oraz kontrolę wszystkich zależnych
wierszy rozszerzonego układu RT0. Niezależny przegląd matematyczny był
read-only; nie wykonywano buildów ani testów natywnych w subagencie.
Focused source-map validator: exit 0. Testy walidatora pozostają objęte
wcześniejszym niezmienionym wynikiem 32/32. Jest to kontrakt wdrożenia,
nie zaimplementowany wspólny solver i nie zamknięcie T05/T06.

Checkpoint receipt ABI+adaptera (2026-10-03): job
`83d0f399849740139ba93ccc96f29d83` ma receipt `state=succeeded`,
wszystkie trzy etapy (`native-build`, `frontend-dependencies`,
`frontend-build`) zakończyły się exit 0. Sprawdzono niezależnie rozmiary
i SHA-256 wszystkich **109 artefaktów**: zero braków i niezgodności.
Frontend przeszedł kompilację webpack, TypeScript oraz eksport statyczny.
Receipt nadal jawnie zapisuje `qualification=NOT VERIFIED`; jego główne
pole `exit_code` jest null, nie należy utożsamiać go z kodami etapów.
Przy tym odczycie koordynator raportował jeszcze `running`, exit null.
Do potwierdzenia terminalnego statusu kolejki jest to zweryfikowany wynik
etapów buildu, nie pełny sukces cyklu joba. Snapshot obejmuje nowe ABI,
retencję V, adapter Rust i wcześniej dodane zmiany runtime; późniejsze
wyprowadzenie matematyczne w nocie nie zmienia zbudowanego kodu.
Nie wykonano natywnych testów jednostkowych (obowiązuje zakaz kompilacji),
publicznego solve→LLG, kwalifikacji prądów portowych ani dowodu WebGL.

Późniejszy odczyt koordynatora potwierdził dla
`83d0f399849740139ba93ccc96f29d83` terminalne `succeeded`, exit 0.
Wraz z powyższym receipt i 109 zweryfikowanymi artefaktami zamyka to
kompilację tego snapshotu. Kwalifikacja fizyczna i runtime pozostają otwarte.

Kolejny krok źródłowy T05/T06: dodano native
`transport/affine_trace_relations.hpp::reduce_affine_trace_relations` i
podłączono go do `PeriodicChargePotentialSolver::Solve` zamiast osobnego
union-find i geometrycznego liftu. Graf akceptuje wiele jawnych relacji
DOF z niezależnymi podpisanymi skokami; po budowie quotient/lift sprawdza
wszystkie oryginalne wiersze w docelowym `double`. Dochodzi regresja
`affine_trace_relations_preserve_independent_jumps_and_reject_cycles`.
Review było read-only; nie znaleziono blokującego błędu operatora, ale
doprecyzowano odmowę reprezentowalności wybranego canonical liftu, która
nie dowodzi sprzeczności wszystkich możliwych gauge. Publiczny request
nadal ma jeden cut i pojedynczy gauge pin; wspólny workspace, multi-cut
port response i terminal-current RT0 są nadal wymagane. Testu natywnego
nie kompilowano; aktualny operator nie był w zbudowanym snapshocie `83d0`.

Build nowego operatora zgłoszono do tej samej kolejki: job
`ed910799ee3243a8b7a378dfc6514f04`, request
`antenna-t06-affine-trace-reduction-20261003`, profil `fem-cpu-release`,
source digest `41d2d20a6c00ca62389902bb9f8052bc2b8a3f78135075e0fc97a67e94a92886`,
capture `ee8cdaf3f9c449c7b50fc48fc7d87b9d`, native source identity
`2caffd7e975d910d2f2d22e78a251433d99c7fb71423b18f7c6ed7f24fcafa4a`.
Capture zakończył się poprawnie; stan przy przyjęciu `queued`, brak exit code.
W kapsule jawnie uwzględniono wszystkie wymagane untracked, w tym nowy
nagłówek operatora. Nie uruchamiano ciężkiego buildu poza kolejką ani
kompilacji testów. Focused scientific validator oraz `git diff --check`
mają exit 0; review nie jest dowodem native runtime. Ten późniejszy wpis
nie należy do zbudowanego snapshotu.

Kolejny checkpoint źródłowy T05/T06 (2026-10-03): właściciel
`backends/fem/cpu/mfem/workflows/antenna_field_solve` ma teraz
`charge_trace_workspace.hpp/.cpp::solve_charge_trace_workspace`.
Składa oryginalne K i affine quotient, usuwa voltage anchory przez
podstawienie, ustala gauge wyłącznie na niezakotwiczonych komponentach,
zwraca owned V i nieeliminowane reakcje K V w kolejności stable vertex IDs.
Łączność opiera się na face adjacency i jawnych relacjach trace;
niekwalifikowane kontakty punktowe/krawędziowe są odrzucane.
Niezależny residual jest sprawdzany osobno dla każdego komponentu,
więc duże wymuszenie nie maskuje błędu małego komponentu.
Periodic solver deleguje H1 do tego etapu i zachowuje legacy mean-zero
oraz ABI. Nie ma jeszcze wspólnego accepted-source digestu, odpowiedzi
port-current ani terminal-constrained RT0; T05/T06 pozostają otwarte.

Review ujawniło dodatkowy błąd akceptacji: duży wspólny voltage anchor
może zatrzeć mały skok po rekonstrukcji V, mimo poprawnego canonical
liftu i zerowego residualu wolnych DOF. Dodano końcową kontrolę wszystkich
zadanych skoków (tolerancja lokalna względem skoku), anchorów i gauge,
przed obliczeniem reakcji i zwrotem wyniku. Regresja
`charge_trace_workspace_rejects_jumps_lost_after_anchoring` ma jeden tet4,
wszystkie quotient DOF ustalone, baseline 0 V/1 V i odmowę przy anchorze
1e20 V. Regresja komponentowa obejmuje dwa niezależne wzbudzenia, trzeci
izolowany przewodnik, analityczne V, signed reactions i owned lifetime.
Obie regresje są źródłowe i niekompilowane zgodnie z zakazem.
Build `ed910799ee3243a8b7a378dfc6514f04` nie obejmuje tego późniejszego
workspace; sukces starszego snapshotu nie może kwalifikować tej zmiany.
Powtórny read-only review potwierdził zamknięcie błędu utraconego skoku
na poziomie źródeł i zgodność fixture z API MFEM v4.7; nie jest to wynik
wykonania testu. Po tej poprawce focused scientific validator noty 0950
zwrócił exit 0, a `git diff --check` nie wykazał błędów whitespace.

Zamrożony snapshot workspace i powyższej korekty przyjęto do istniejącej
kolejki jako job `8df9b8ef235d4eaa8402498347a3d033`, request
`antenna-t06-charge-trace-workspace-20261003`, profil `fem-cpu-release`.
Source digest: `73a6ad84ffbeb42c4c80d1d97c3f1a23824bcd81f2051ce2f6e28bd75eda4a84`;
capture: `af3939c7575d4bf987f13fc05638ee5d`; native source identity:
`8fbd5d6eb60168881bd0cb9608a3cf06bbbf232ccd00b69305971b4a0d7e8c96`.
Przy przyjęciu stan `queued`, bez wyniku buildu. Jawnie włączono wszystkie
untracked pliki wymagane przez snapshot, w tym nowy workspace i nagłówek
affine trace. Późniejszy wpis z tożsamością joba nie należy do jego kapsuły.

Następny krok ustalony przez read-only audyt aktualnych źródeł:
natywny response-current owner nad wspólnym operatorem H1, następnie
jawny adapter terminal/cut/lead i terminal-constrained RT0. Publiczne
`ResolvedFemBoundaryMarkerSetIR` ma boundary attributes, a
`requested_antenna_terminal_currents` mapuje gałęzie na outward
`F_in=-w`, `F_out=+w`. Brakuje jednak powiązania tych terminal IDs ze
stable physical face keys i actuatorami nowej domeny closure.
`ConservativeCurrentSourceCutIR` nie wskazuje publicznych terminal IDs;
external lead definiuje jedną parę outer electrodes, nie dowolny zestaw
niezależnych returnów. Nie wolno zastępować tej brakującej informacji
heurystyką nazw ani współrzędnych.

Wymagana kolejność kontraktów dalszej implementacji:

1. Właściciel response-current używa jednej ustalonej dyskretyzacji,
   przewodności i oryginalnego K; zmienia wyłącznie zadane wartości
   niezależnych voltage/jump controls. Nie przenosi niejawnego seed drop
   z legacy solve. Unit i final solve muszą mieć tę samą przestrzeń
   dopuszczalnych wariacji, komponenty i gauge.
2. Adapter postmeshing wiąże terminal ID z fizycznymi ścianami, H1 DOF,
   komponentem, stroną cut/interface i orientacją. Odrzuca nakładanie
   terminal DOF i niejednoznaczny udział terminal/cut. Reakcja conjugate
   actuator nie zastępuje automatycznie outward terminal current.
3. Response solve sprawdza niezależność controls i zgodność prawej
   strony bez regularizacji/pseudoodwrotności; skaluje rząd i prądy
   per komponent. Ponownie mierzy końcowe signed currents z K V,
   również na terminalach zerowo wzbudzonych.
4. RT0 zachowuje zaakceptowane sumy terminalne w rozszerzonym D i
   sprawdza zależności wszystkich wierszy oraz wszystkie pominięte
   warunki po solve. Sam bilans closure nie wystarcza.
5. Closure-aware ABI jest append-only. Dopiero jeden zaakceptowany
   snapshot V/RT0/certificate/H pozwala usunąć oddzielny legacy H1
   z runnera i promować producenta artefaktu.

Te punkty są planem dalszego wdrożenia, nie kodem response-current ani
dowodem kwalifikacji T05/T06. Właściciel pozostaje native FEM CPU;
nie dodawać tej numeryki do Rust ani nowego cross-cutting stanu Context.

Checkpoint dalszego wykonania 2026-10-03: job
`ed910799ee3243a8b7a378dfc6514f04` zakończył się `succeeded`, exit 0;
receipt ma wszystkie trzy etapy exit 0 oraz `qualification=NOT VERIFIED`.
Sprawdzono niezależnie rozmiar i SHA-256 **109/109** artefaktów, bez
braków lub niezgodności. Jest to dowód buildu operatora affine trace,
nie późniejszego workspace, response-current ani kwalifikacji naukowej.
Job `8df9b8ef235d4eaa8402498347a3d033` jest `running`; potwierdzono żywy
kontener workera. Nie anulowano ani nie restartowano aktywnego buildu.

Po capture tego joba wydzielono persistent `ChargeTraceWorkspace`.
Oryginalne K jest deep-copy macierzy MFEM i powstaje raz; owner przechowuje
owned mapy, carrier i topologię, nulluje borrowed mesh/material, a kolejne
solve zmieniają wyłącznie wartości. Nowa regresja source-only sprawdza
brak ponownego Eval conductivity po jej mutacji, rozwiązanie po
zniszczeniu borrowed wejść oraz niezmienność wcześniejszych wyników.
Review wychwycił błędne założenie fixture, że cube nie ma węzłów x=0.5;
regresja porównuje teraz cały owned carrier zamiast tylko endpointów.

Dodano `charge_current_response.hpp/.cpp::solve_charge_current_response`:
zero baseline, 1–64 niezależne voltage controls, unit/final solve na tym
samym K, energetyczna response matrix, scaled symmetry i Cholesky bez
regularizacji, local potential superposition oraz osobne predicted/final
signed conjugate-current gates. Model i SI wyprowadzono wcześniej w 0950.
Wynik jest owned, ale nie certyfikuje fizycznych terminali ani RT0.
Nie przełączono jeszcze publicznego producenta na ten właściciel.

Review ujawniło fałszywy common-mode przy approximate unit solve. Dodano
kontrolę authored jumps/anchors i komponentów przed H1; regresja wymaga
konkretnej odmowy przy tolerancjach 1e-12 i 1e-3. Powtórny review zamknął
tę blokadę na poziomie źródeł. Ogólne zależne kombinacje z dużym offsetem
wymagają dalszej kwalifikacji energy rank, nie są symbolicznie certyfikowane.
Regresje response obejmują trace oraz terminal-anchor controls, signed
currents 1 i 0.0001 A, przewodności 4 i 0.0004 S/m, reversal, zero RHS,
zależności oraz hidden baseline. Nie kompilowano ani nie wykonywano
natywnych testów; zakaz pozostaje w mocy. Nowy owner i refaktor nie
należą do snapshotu `8df9`. T05/T06 nie są ukończone.

Snapshot persistent operator + conjugate response przyjęto do istniejącej
kolejki jako job `9c541db3b0da484c8755fb2702954fde`, request
`antenna-t05-conjugate-current-response-20261003`, profil `fem-cpu-release`.
Source digest: `f7fc49ff78bfc67c7a9fd7b7275b5de6597acc664f76c985be88e34b3bcc0367`;
capture: `fd7a4baef266422b807bfd488e632c31`; native source identity:
`8d01f72d919789f0de7b56ccf4757041e5b0c4f69a6dfb534f3e73b96dd8cfba`.
Przy przyjęciu `queued`, bez wyniku. Focused validator 0950 i
`git diff --check` zwróciły exit 0 przed capture. Uwzględniono wszystkie
wymagane untracked źródła. Ten job kwalifikuje co najwyżej kompilację,
nie rozwiązuje poniższego ryzyka naukowego.

Dalsza analiza ujawniła wymaganie source-certified rank modulo nullspace
oryginalnego K: jego kernel zawiera stałe na każdej face-connected objętości
przed identyfikacją trace, nie tylko stałą na komponencie elektrycznym po
tej identyfikacji. Sam niezerowy jump między rozłącznymi objętościami
może zmienić wyłącznie ich stałe potencjały i mieć energię zero.
Pojedynczy gate authored common-mode oparty na zerowych jumps nie obejmuje
tego przypadku, a mała dodatnia energia błędu/roundoff nie może być
certyfikatem rzędu. Wymagane jest sprawdzenie niezależności controls modulo
wszystkie stałe objętości z constraints przed unit solve, następnie osobny
numerical energy gate. To otwarta bramka kwalifikacji private response;
nie promować publicznego producenta na podstawie jego obecnego source/build.

**Checkpoint źródłowy 2026-10-03 — dokładny rząd controls.** Przed kodem
uzupełniono 0950 o równania `antenna-authored-control-nullspace-rank` i
`antenna-authored-control-compatibility-rank`, jednostki oraz source-map.
Native owner `charge_control_nullspace_rank.cpp::validate_charge_control_rank`
sprawdza dwa kolejne dokładne grafy: wykonalność w pełnych DOF, następnie
rząd modulo stałe pierwotnych face-connected objętości oryginalnego K.
Owned mapę zapewnia `ChargeTraceWorkspace::original_volume_component_for_full_dof`;
nie jest ona zastępowana electrical quotient po trace. Współczynniki
binary64 są dekodowane do dyadycznych integers, cykle i rank obliczane
bez tolerancji H1. Kontrola poprzedza wszystkie unit CG również dla
zero RHS. Scaled Cholesky jest teraz osobną bramką numerical conditioning,
nie dowodem source rank. Odmowy zasobowe mają odrębny komunikat; limity
controls/edges/nodes/cells/bits/work/storage opisano w 0950.

Regresja źródłowa
`charge_current_controls_require_exact_rank_modulo_original_volumes`
obejmuje inter-volume jump bez prądu, zgodne anchory takich stałych,
within-volume controls, near-binary64/min-subnormal rank, zależność
ukrytą przez common-mode 2^40, permutacje, niewykonalny cykl oraz
przekroczenie edge/bit budget. Niezależne read-only review potwierdziło
kryterium i znaki weighted forest; wykryty mismatch komunikatu błędu
regresji poprawiono. Nie kompilowano ani nie wykonywano tych testów.
Focused validator 0950 i `git diff --check` zwróciły exit 0 po integracji.
Zmiany nie należą do snapshotów `8df9` ani `9c541`; nowy build i
kwalifikacja runtime/nauki pozostają wymagane. T05/T06 nadal otwarte.

Snapshot z dokładnym rank gate i wszystkimi wymaganymi untracked wejściami
przyjęto do istniejącej kolejki: job `cd4493a10de84528b5f142c8c841cec0`,
request `antenna-t05-authored-control-exact-rank-20261003`, profil
`fem-cpu-release`; source digest
`5f4e397b7f69315012db50bb378a2ed1c4450d7e59e3049e9bc0cda75a4e4543`,
capture `c716d921e0ea4117bb2d852898dc8b1d`, native source identity
`09d7e6753a5ab7281c98bc6a452fea576fbd2ab6641a04bb40c7a528969369f1`.
Przy przyjęciu `queued`, bez wyniku. Sprawdzono zdrowie runnera:
`accepting_jobs=true`, `worker_alive=true`, `worker_error=null` oraz
obsługę profilu. Wszyscy edytujący agenci zakończyli pracę przed capture;
źródła pozostawały zamrożone do potwierdzenia utworzenia kapsuły.
Nie anulowano aktywnego joba `8df9`; wcześniejszy `9c541` pozostawał
w kolejce. Nowy wpis statusu powstał po capture i nie zmienia zbudowanego
snapshotu. Sukces buildu, wykonanie regresji i kwalifikacja fizyczna
tego rank gate nie są jeszcze potwierdzone.

**Checkpoint buildu 2026-10-04 — exact authored-control rank.**
Job `cd4493a10de84528b5f142c8c841cec0` ma potwierdzony przez kolejkę
stan `succeeded`, exit 0. Wszystkie trzy etapy receipt mają exit 0;
niezależnie sprawdzono rozmiar i SHA-256 **109/109** zapisanych artefaktów.
Source digest jest dokładnie
`5f4e397b7f69315012db50bb378a2ed1c4450d7e59e3049e9bc0cda75a4e4543`.
To dowód buildu exact-rank kapsuły, nie wykonania regresji ani proof
conditioning/numerical correctness. Nie obejmuje późniejszych prepared
terminal controls, terminal RT0, owned H1/RT0 interfaces, content digest
lub nowego record ABI. Receipt nadal ma `qualification=NOT VERIFIED`.

**Checkpoint buildu 2026-10-03 — pierwotny charge trace workspace.**
Job `8df9b8ef235d4eaa8402498347a3d033` ma potwierdzony przez kolejkę
stan `succeeded`, exit 0. Receipt zapisuje exit 0 wszystkich trzech
etapów i `qualification=NOT VERIFIED`; niezależnie sprawdzono rozmiar
oraz SHA-256 109/109 artefaktów, bez braków lub niezgodności. To dowód
buildu wyłącznie kapsuły o source digest `73a6ad84ffbeb42c4c80d1d97c3f1a23824bcd81f2051ce2f6e28bd75eda4a84`.
Nie obejmuje późniejszego persistent workspace, odpowiedzi prądowej,
exact rank ani niżej opisanego adaptera physical terminals. Regresje
natywne nadal nie były kompilowane ani wykonywane zgodnie z zakazem.

**Checkpoint źródłowy 2026-10-03 — przygotowany operator i terminale.**
Przed adapterem uzupełniono 0950 o kontrakt
`antenna-resolved-terminal-current-adapter`: real stable-ID boundary
faces, rzeczywiste P1 DOF, per-component reference/balance, all-terminal
signed certificate i ograniczenia zero-jump continuity. Wydzielono
`solve_charge_current_response_prepared`, które używa jednego frozen K;
`require_control_topology` sprawdza ordered stable IDs, trace/anchors
i solver policy bez odczytu borrowed mesh/material. Dodano źródłową
regresję lifetime, frozen conductivity i odmowy zmiany metadanych.

Nowy `charge_terminal_current_constraints.hpp/.cpp` rozwiązuje jawne
fizyczne terminale, również reference/requested-zero. Zweryfikowane
physical face groups, accepted V/K V, napięcia i podpisane prądy są owned.
Nie przypisuje potencjału po nazwie ani arbitralnym indeksie DOF i nie
tworzy sztucznego control przy braku niezależnych kolumn.

Niezależne review wykryło niepełne odwrotne domknięcie faces po wyborze
essential DOF: pominięty trójkąt z trzema już zakotwiczonymi węzłami
otrzymywał niejawny Dirichlet trace, nieobecny w wyniku faces do RT0.
Adapter odrzuca teraz taki brak i fully essential separator o mieszanej
terminal ownership. Ograniczenie dyskretyzacji zapisano w 0950 przed
poprawką kodu. Nie oznacza to nieistnienia rozwiązania ciągłego.
Nowy adapter nie jest jeszcze podłączony do publicznego producenta,
accepted-charge RT0 ani append-only RT0-current ABI. Nie należy do
snapshotów `8df9`, `9c541` ani `cd449`; T05/T06 nadal są otwarte.

Dodano trzy called-main źródłowe regresje physical terminals:
referencja wybrana prawdziwymi fixture stable IDs zamiast authored order,
signed currents obu elektrod i analityczne V, reversal/scaling,
single-zero bez response, rozłączne przewodności 4 i 0.0004 S/m,
prądy 1 i 0.0001 A oraz isolated metal. Jawny zero-jump interface
łączy dwie objętości z odrębnymi stable IDs w pełny szereg długości 2 m.
Odmowy unknown/duplicate/shared DOF, per-component imbalance,
spanning, trace alias i nonzero cut sprawdzają konkretne komunikaty.
Fan pyramid odrzuca pominiętą ścianę mimo pełnego DOF coverage;
coarse cube odrzuca fully essential mixed separator. Testy nie były
kompilowane ani wykonywane. Silnie sprzężony mały return CPW nadal
wymaga oddzielnego dowodu; disconnected small component nie zastępuje go.

Ponowny niezależny read-only review potwierdził zamknięcie obu odmian
face-closure blockera i spójność zamrożonych fixtures oraz komunikatów
odmowy. Nie znaleziono nowego blockera tego fragmentu. Focused validator
0950 i `git diff --check` zwróciły exit 0; nie oznacza to wykonania
natywnych regresji ani kwalifikacji numerycznej.

Najmniejsza następna integracja: osobna typed native accepted-terminal
projection, nie legacy voltage-driven `Build` ani
`raw_single_valued_potential`. Odtworzyć rzeczywiste P1 z owned V
dopiero po kontroli stable IDs, vertex order, geometrii i wspólnego
mesh/material provenance. Do pełnego D `[div; paired; terminals]`
dodać orientowane sumy terminalowe z RHS **zmierzonym H1 current**,
nie samym requested current. Istniejący exact rank owner musi sprawdzić
pełny układ i jego dependent RHS; po RT0 powtórzyć wszystkie terminale
oraz omitted rows. Pierwsza ścieżka bez trace interfaces musi je jawnie
odrzucać, dopóki nie istnieje rzeczywista face-pair closure mapping.
Pierwszy runtime dowód wymaga request ↔ H1 ↔ RT0 signed flux, reversal
i zachowanych owned V; samo przekopiowanie V nie zamknie tej luki.

Zamrożony snapshot prepared response + physical terminal adapter z
poprawką closure, regresjami i dokumentacją przyjęto do jednej
istniejącej kolejki: job `1a11fc90b5224311ad01c4a01a2ac164`, request
`antenna-t05-physical-terminal-current-adapter-20261003`, profil
`fem-cpu-release`; source digest
`84f8ea635698824e9359324b6ef2ff66c0ed861b9f41989cf492a85335559263`,
capture `0fc51b8c05e14333b9daefd7bb8ac43b`, native source identity
`634710a3c80c40bb6b1e9117c956a5b3cd3cd0a0cee3cf09895066cb09318742`.
Przy przyjęciu `queued`, bez wyniku buildu. Włączono wymagane untracked
pliki; edycje pozostawały zamrożone do zakończenia capture. Runner ma
`ok=true`, `accepting_jobs=true`, `worker_alive=true`, `worker_error=null`
i obsługuje ten profil. Job `9c541` wcześniej potwierdzono jako `running`,
`cd449` jako `queued`; nie uruchamiano równoległego ciężkiego buildu
ani nie kompilowano testów jednostkowych. Ten wpis powstał po capture.

**Kolejny checkpoint źródłowy 2026-10-03 — terminal-constrained RT0.**
Przed kodem dopisano w 0950 kontrakt
`antenna-rt0-terminal-projection-prerequisite` z kompletną tabelą wejść
i oddzieleniem numeric projection od accepted-source provenance.
Nowy `terminal_constrained_rt0_projection.hpp` definiuje prywatny
owned wynik i `Rt0TerminalFluxConstraint` ze zmierzonym signed H1 RHS.
`project_terminal_constrained_rt0` w istniejącym ownerze transportu
używa pełnego rank `[div; terminals]` i weighted KKT. Do obu
wewnętrznych operatorów dodano optional terminal rows; pusta lista
domyślna zachowuje legacy `Build` bez zmiany jego semantyki.

Niezależny pomiar RT0 sprawdza wszystkie elementy, interior/insulating
faces i każdy terminal przy własnym progu, również omitted rows.
Serial/nonconforming/curved oraz malformed face/current inputs
są jawnie walidowane. Nie ma pairing/trace interfaces w tej ścieżce.
Review potwierdziło zgodność canonical outward signs i MFEM signs
jako zmiany orientacji kolumn oraz integralne RT0 DOFs. Wyłapany
problem `inf <= inf` usunięto przez jawne finite checks residuali,
akumulowanych skal i progów. To source review, nie numerical PASS.

Źródłowe called-main regresje wymagają H1 ±2 A → RT0 Jx=±2 A/m²
przy celowo odmiennym raw Jx=1 A/m², zero-current, relabelling
stable IDs zmieniający canonical orientation, specific inconsistent
dependent RHS, full measurement/rank oraz owned lifetime. Druga
regresja ma σ4/0.0004 S/m, prądy 1/0.0001 A, dwie zależności i
własne progi wszystkich czterech terminali. Nie kompilowano ani nie
wykonywano tych testów. Zero-current leakage przy ścisłym progu
1e-18 A wymaga runtime dowodu, nie poluzowania testu.

Ten nowy operator **nie należy** do kapsuły `1a11fc9`. Wciąż brakuje
typed wspólnej tożsamości V/mesh/material, accepted-terminal workflow,
actual face-pair interfaces, append-only ABI i publicznego producenta.
Dowolny raw coefficient nie jest accepted charge; nie można użyć
tej prywatnej projekcji jako kompletnej anteny ani obejść legacy
zakazu `raw_single_valued_potential`. T05/T06 pozostają otwarte.

Ponowny niezależny read-only review po poprawce finite checks i jawnej
odmowie nonconforming mesh nie znalazł kolejnego blockera źródłowego.
Objął signed/zero currents, relabelling, dependent RHS, omitted rows,
owned lifetime oraz rozłączne skale prądu. Focused validator 0950
i `git diff --check` zakończyły się exit 0. Nagłówek nowego operatora
sprawdzono również osobno na whitespace, ponieważ jest untracked.
Są to dowody źródłowe; brak kompilacji i wykonania regresji pozostaje
jawny. Kolejny pełny build ma objąć ten operator w zamrożonym snapshot,
bez zmiany dotychczasowych dowodów kapsuły `1a11fc9`.

Snapshot operatora terminal-constrained RT0 przyjęto jako job
`38281c8458104515a8bebeb4c2a6a56c`, request
`antenna-t06-terminal-constrained-rt0-projection-20261003`, profil
`fem-cpu-release`; source digest
`b7261ddd1963b1475ca935ba3a04503b63890ef9d20d221adac894ccf6a7c03b`,
capture `050c810009c3446695c83743dec54365`, native source identity
`37f4e049327f80a0176f368197aa6c18c98c1143b617dd0a5e1ca71140f1aa4c`.
Przy przyjęciu stan `queued`, bez wyniku buildu. Capture obejmuje
wszystkie wymagane untracked pliki, regresje i poprawki finite/NC;
nie obejmuje późniejszej integracji owned V/mesh/material. Źródła nie
zmieniały się podczas capture. Koordynator jest zdrowy; `9c541` nadal
`running`, `cd449` i `1a11fc9` są `queued`. Nie kompilowano testów
jednostkowych ani nie uruchomiono drugiego ciężkiego wykonawcy.

**Kolejny checkpoint źródłowy 2026-10-03 — owned terminal V/σ/J.**
Kontrakt `antenna-owned-terminal-charge-source` w 0950 zapisano przed
kodem. Nowy `accepted_terminal_charge_source.{hpp,cpp}` rozwiązuje
otwarty conductor/terminal problem na jednej owned mesh z dokładnie
zamrożoną elementwise scalar conductivity. Nie próbkuje dowolnego
borrowed coefficient jako pozornego materiału. Używa istniejących H1
terminal reactions i measured RHS RT0; nie wykonuje drugiego solve H1.
Import accepted V sprawdza ordered real IDs/xyz i rzeczywistą bijekcję
GetVertexDofs. Dokładny affine P1 gradient tworzy internally derived
raw J; caller nie może podmienić raw current ani sigma między etapami.

Nowy owned endpoint RT0 przejmuje mesh. Tymczasowe P1 użyte do raw J
kończy życie przed transferem, więc odmowa rank/KKT nie zostawia
dangling FE space. Retained P1 powstaje po udanej projekcji na tej
samej mesh pointer; lifetime ownera kończy P1 przed RT0/mesh. Końcowy
requested→RT0 certificate sprawdza każdy terminal na requested scale,
oddzielnie od H1→RT0. Wszystkie trace relations, także zero-jump,
są odrzucane, ponieważ RT0 nie ma jeszcze actual interface pairing.

Niezależny review znalazł odziedziczony geometry blocker: legacy
tetra validator używał `max(edge norms,1 m)` i odrzucał regularne
elementy mikro/nanometrowe. Shared terminal mesh preflight używa teraz
bezwymiarowego normalized determinant, przed clone/H1, z serial,
straight i conforming gates. Legacy `Build` zachowuje dotychczasową
walidację i nie otrzymuje cichej zmiany semantyki. Pozostałe absolute
pivot/solver thresholds weighted KKT nadal wymagają analizy conditioning
i dowodu runtime w SI; nie są kwalifikowane przez sam shape preflight.

Called-main źródłowe regresje: σ4/8 S/m w szeregu, Vright=-3/16 V,
Jx=1 A/m², one-mesh P1/RT0, zachowane attributes/order/material/IDs,
mutacja i zniszczenie źródeł, reversal/zero, trace/malformed sigma
rejection. Regularny fixture L=1e-9 m, σ1e7 S/m, I1e-9 A wymaga
Jx1e9 A/m², gradientu -100 V/m i Vright=-1e-7 V; collapsed mesh
ma być odrzucona przed H1. Jest to test modelu i jednostek, nie
twierdzenie o fizycznej ważności kontinuum na skali 1 nm.
Nie kompilowano ani nie wykonano regresji. Ponowny read-only review
nie znalazł dalszego blockera w zakresie ownership/material/signs.

Nowy owner jest podłączony do production CMake oraz istniejącego
test targetu źródłowego, lecz **nie należy** do kapsuły `38281c8`.
Jest prywatnym accepted open-terminal V/σ/J, nie domkniętym źródłem
anteny. Wciąż potrzebne są cut/lead closure, trwały digest i append-only
ABI, integracja publicznego producenta oraz osobne native scientific
i runtime gates. T05/T06 pozostają otwarte.

Końcowy source review objął też oba nowe fixtures i production/test
CMake wiring; nie wskazał dodatkowego blockera. Focused validator 0950
i `git diff --check` zakończyły się exit 0; trzy nowe untracked źródła
sprawdzono osobno na whitespace. Nie jest to numerical/runtime PASS.

Wcześniejszy job `9c541db3b0da484c8755fb2702954fde` zakończył się
`succeeded`, exit 0; native-build, frontend-dependencies i frontend-build
mają po exit 0. Niezależnie zweryfikowano sizes i SHA-256 **109/109**
artefaktów z `build-receipt.json`; source digest
`f7fc49ff78bfc67c7a9fd7b7275b5de6597acc664f76c985be88e34b3bcc0367`,
native source identity
`8d01f72d919789f0de7b56ccf4757041e5b0c4f69a6dfb534f3e73b96dd8cfba`.
Receipt zachowuje `qualification=NOT VERIFIED`. Jest to build kapsuły
persistent workspace + pierwszej conjugate response; **nie obejmuje**
późniejszych exact rank, prepared response, physical terminal adapter,
terminal RT0 ani nowego owned source. Zielonego wyniku nie przenosi się
na te późniejsze źródła.

Pełny snapshot owned terminal source przyjęto do kolejki jako job
`fb6dde484c914e73914d2947ca239fe9`, request
`antenna-t06-owned-terminal-charge-source-20261003`, profil
`fem-cpu-release`; source digest
`2dd02d361a733d5ce5364b5dcbdeb2b0d452e4d2425e39c4f5fb73791147d504`,
capture `817b31b2bc15470fb2c9f890f538dcdb`, native source identity
`abaa2732a7153ff8c3e80ea4872d83879728d3613755a6a2ce6596a9fa9340e2`.
Przy przyjęciu stan `queued`; wyniku buildu nie ma. Kapsuła obejmuje
owned workflow, wspólny scale-independent mesh preflight, ownership
transfer RT0, regresje i dokumentację z wymaganymi untracked plikami.
Edycje były zamrożone podczas capture. Ten wpis powstał po capture.

Następny konkretny krok to typed interface-face constraints dla
terminal RT0, a potem current-driven external-lead workflow. Nie
wolno dopisać closure do już obliczonego otwartego V: lead zmienia
problem brzegowy, więc cały device+lead musi mieć wspólny H1 solve.
Wymagane są actual stable-ID face/vertex maps, zero-jump H1 continuity,
RT0 div/pair/terminal rank i niezależne pomiary. Legacy nonzero
`outer_electrode_potential_drop_v` nie jest dodatkowym actuatorem
current-driven source; napięcia mają wynikać z zadanych prądów.
Publiczny native current ABI musi później zastąpić dwa osobne solve
w runnerze jednym accepted V/material/RT0/terminal result. Closed
geometry multi-cut actuators pozostają osobną realizacją; nie wolno
udawać ich terminalami ani inferować CPW return splitting.

**Kolejny checkpoint źródłowy 2026-10-03 — explicit RT0 interfaces.**
Kontrakt `antenna-terminal-rt0-explicit-interfaces` zapisano przed
kodem. Private numeric projection przyjmuje optional
`Rt0InterfaceFacePair`: rzeczywiste exterior face keys, trzy jawne
stable-ID vertex pairs, exact-coincident xyz i przeciwne outward
normals. Terminal overlap, ponowne wykorzystanie faces, niepełne
bijections i malformed IDs są odrzucane. Pusta lista zachowuje
dotychczasową ścieżkę; source cuts i arbitrary H1 traces nadal nie
są tym interfejsem. Rank i weighted KKT otrzymują pełne
`[div; pair; terminal]`; każda para ma niezależny outward pomiar obu
stron i własny finite mismatch gate, także dla omitted rows.

Called-main source fixture łączy dwa bloki przez dwie rzeczywiste
pary triangli z disjoint stable IDs. P1 zero-jumps są wyprowadzone
wyłącznie z tych samych vertex maps/GetVertexDofs; RT0 RHS to
measured H1 currents. Przy σ4 S/m i I±1 A wymagane V=-I*x/4,
Jx=I A/m² i dwa signed strumienie ±I/2 A na każdej parze.
Full rank ma NE+4 rows i jedną compatible dependency. Sprawdzane
są reversal, permutacje oraz specific vertex-map/face-reuse/terminal
overlap/coincidence/opposite-normal refusals. Nie kompilowano ani
nie wykonano testu. Read-only operator review nie znalazł nowego
blockera; native/runtime qualification pozostaje otwarta.

Te nowe paired źródła **nie należą** do kapsuły `fb6dde4`.
Do publicznego pola potrzebny jest wspólny current-driven device+lead
H1/material/RT0 workflow i następnie typed closure/ABI/producer.
Sama numerical projection nie dowodzi H1 continuity ani closure.

**Kolejny checkpoint źródłowy 2026-10-04 — wspólne H1/RT0 interfaces.**
`AcceptedTerminalChargeRequest.interface_pairs` rozszerza istniejący
private owner bez nowego publicznego modelu. Jedna zamrożona cała mesh,
elementwise σ i authored face/vertex maps przechodzą wspólny
`validate_terminal_current_interfaces` przed H1. Actual stable IDs
mapowane przez `GetVertexDofs` wyznaczają zero-jump P1; dedup obejmuje
tylko te same jawne pary węzłów. Te same owned pairs trafiają do RT0,
a raw J nadal pochodzi wyłącznie z zaakceptowanego V i σ. Caller DOF
trace passthrough, inferred contact/weld i dodanie leadów po solve są
zabronione. Wynik utrzymuje także immutable interface maps.

Called-main fixture `accepted_terminal_charge_source_freezes_explicit_interface_series`
obejmuje dwa bloki długości 1 m/przekroju 1 m², σ4/8 S/m, I=1/−1/0 A,
R=3/8 Ω, Vinterface=-I/4 V i Vright=-3I/8 V. Sprawdza whole-domain
H1/P1/RT0, wspólną mesh pointer identity, prądy wszystkich terminali
oraz obu stron każdej pary, frozen map/material lifetime i konkretne
pre-H1 odmowy (maximum_iterations=0 jako marker). Istniejący fixture
numeric RT0 współdzieli tylko testowy helper tworzenia declared maps.
Nie kompilowano ani nie wykonano testów jednostkowych. Skupiony
validator noty/source-map oraz `git diff --check` mają exit 0.
Nowe źródła nie należą do żadnej wcześniej zleconej kapsuły.
Niezależny read-only przegląd owner/preflight/lifetime nie znalazł
blockera źródłowego. Zero-jump equivalence może obejmować wielodomenowy
junction; nie wprowadzono fikcyjnego globalnego vertex→jedyny partner
warunku, który zabraniałby poprawnych rozgałęzień. Każda face pair
pozostaje jawna, bijekcyjna i niezależnie mierzona. Review nie dowodzi
wykonania solvera ani zbieżności fizycznej.
To nie jest jeszcze versioned external-lead closure certificate,
closed-cut actuator, append-only ABI ani publiczny producent pola.
T05/T06 i numerical/runtime qualification pozostają otwarte.

Zamrożony fragment common H1/RT0 interfaces zlecono w istniejącej kolejce:
job `b9fdd2c8f0d345b98d8ee5808c14c904`, request
`antenna-t06-owned-h1-rt0-typed-interfaces-20261004`, profil
`fem-cpu-release`, source digest
`ba11e88bfbf3cbc47cd0b855b7521f437fce248eee7c137638b453b7e492f9f8`,
capture `51002f1a794d496b801b2c46304a442d`, native source identity
`9699dba704ab49e94c8a3c855f919b1361a0847ae94478bacdd51dbc6293425c`.
Stan po capture: **queued**. Kapsuła zawiera numeric pairs, shared
preflight, owned H1/RT0 integration oraz source regressions; nie zawiera
późniejszego digest/ABI/typed closure ani kwalifikacji. Wpis z metadanymi
buildu dodano po snapshot i nie należy do tej kapsuły.

**Kolejna granica integracji — ustalenie 2026-10-04.**
Read-only analiza rzeczywistych ABI/producerów potwierdziła, że zwykły
charge V3 nie przenosi stable vertex IDs/interfaces, a legacy closure
RT0 V1 nie ma signed integral current controls. Publiczny producer
anteny nadal łączy pierwszy charge V/J z drugim closure RT0/H solve;
istniejący charge snapshot drugiego solve nie certyfikuje zadanych
prądów pierwszego. Nie wolno podmienić tylko V, divisor lub H i uznać
wyniku za wspólne źródło.

Następny bounded przyrost to append-only accepted-terminal charge ABI
bez H: actual mesh/stable IDs/σ/terminal faces/signed currents/typed
interfaces → jeden owned V/material/RT0/current result i niezależnie
wyliczony content digest. Nie osadzać spin request ani wymyślonych
ordinal stable IDs. Publiczny H wymaga osobnego current-driven closure
adaptera; `EvaluateField` nie zastępuje certyfikatu closure ani identity.
External-lead IR obecnie ma face pairs bez authored vertex bijections
oraz voltage drive bez branch→outer-current control map. Closed source
cuts są niezerowymi translated voltage jumps, nie metal–metal
zero-jump interfaces. Obie luki muszą otrzymać jawne kontrakty, bez
sztucznego voltage drop, inferred CPW returns lub automatycznego weld.

**Kolejny checkpoint źródłowy 2026-10-04 — content digest accepted charge.**
Private `AcceptedTerminalChargeSource::content_digest()` wiąże własny
ordered payload poprzez schema `accepted_terminal_charge_source.ordered.v1`
i operator `fem_accepted_terminal_charge_source.v1`. Nie używa caller
geometry/material/field digest jako dowodu danych. Preimage obejmuje
actual owned mesh ordering/connectivity/attributes/stable IDs/σ,
V/K*V/component/reference/gauge, RT0 face/DOF/sign map i coefficients,
requested/H1/RT0 terminal currents/voltages, exact interface maps/fluxes,
rank ledger oraz cztery scalar solver policy fields. Native typed
builder jest istniejącą utility; każda double jest finite, zero
normalizowane, liczby/framing są big-endian. Dokładny bound 128 MiB
sprawdzany jest przed field append z subtraction accounting.
To limit preimage, nie peak RAM; auxiliary response diagnostics nie
są osobną serializacją grafu obiektów. Digest powstaje dopiero po
acceptance gates i retained P1 reconstruction, bez borrowed danych.

Niezależny read-only source review nie znalazł blokera serializer,
budget accounting, CMake ani lifetime. Called-main regression
`accepted_terminal_content_digest_matches_independent_owned_codec`
korzysta z osobnego codec oraz testowego SHA-256 (abc known-answer),
odtwarza rzeczywisty wynik bez production buildera. Sprawdza repeat,
retained lifetime i zmianę digestu dla current reversal, σ, geometry,
real IDs, element/boundary attributes, terminal/interface IDs i policy.
Nie kompilowano ani nie wykonano regresji. Te zmiany **nie należą**
do wcześniejszej kapsuły `b9fdd2c8f0d345b98d8ee5808c14c904` ani żadnej
wcześniejszej. Nie ma promocji closure/H/ABI/public producer/runtime.

Wspólny fragment z digestem i niezależną source regression zlecono jako
job `a6330583011b4353aaffb8d2cdde9be1`, request
`antenna-t06-accepted-charge-content-digest-20261004`, profil
`fem-cpu-release`; source digest
`8120ca24f901384e5cff4d46f9f69e7d052e827cecc05c6e2563e475482aa167`,
capture `cc098bed112d40e29180e94ce842d1f6`, native source identity
`21440f999fd217f364ffb4ece52b90d0934c196e1cef15e8d22eb86311dcdc68`.
Stan po capture: **queued**. Skupiony validator noty/source-map oraz
`git diff --check` zakończyły się exit 0. Snapshot obejmuje wszystkie
wcześniejsze źródła common H1/RT0 interfaces, digest oraz oracle;
nie obejmuje późniejszego ABI/consumer/closure ani kwalifikacji.
Metadane i ten wpis dopisano po capture.

**Checkpoint źródłowy 2026-10-04 — ABI jednego accepted charge record.**
Po nocie naukowej dodano append-only `fullmag_fem_solve_accepted_terminal_charge_v1`:
owned H1/material/RT0 source zatrzymuje dokładny typed stream hashowany
przez builder, a adapter publikuje ten stream w bounded caller buffer.
Nie istnieją obok niesprawdzone V/RT0 buffers. Bounded mesh preflight
sprawdza pełne CSR i actual exterior przed MFEM; preserving cell markers
nie aktywuje fizyki. Serial CPU/double, GPU/periodic fail closed.
Layout AMD64 terminal/interface/request/result 32/104/360/656 bytes ma
source C assertions i Rust production const assertions; istniejące ABI
nie są zmienione. Reviewer wykrył zapis pełnego result przed sizegate
oraz seam refusal po importerze. Poprawiono sizegate i kolejność;
truncated prefix/canary jest osobną source regression.

`native_fem/accepted_terminal_charge.rs` wykonuje jeden call i porównuje
identity/header/buffer, hash oraz decoded request-bound content.
`accepted_terminal_charge/record.rs` ma independent strict BE codec:
names/tags/lengths/counts/finite normalized binary64/full consumption,
actual stable ID/tet-face/adjacency/RT0 signed-DOF maps, references,
components/gauges, interface maps, rank ledger i signed current gates.
Review dodatkowo wykrył brak bound controls przed Rust copies oraz
quadratic reference lookups; dodano wczesne counts/checkedsum oraz
indeksy. Algebra i geometry acceptance nadal należą do native owner,
nie do structural decoder. Bufor adaptera jest bounded 128 MiB, ale
retained capacity i peak RAM wymagają pomiaru; nie ukrywamy kosztu.

W źródłach: 58 C ABI odmów i cztery layered sigma4/8 solves (+1/repeat/-1/0),
niezależny exact bytes/SHA oracle; owner oracle sprawdza także exact
retained preimage; trzy testy Rust synthetic codec (nie native solve),
wrong/stale hash, rehashed corrupt counts/maps/scalars/text i full
consumption. Żadnego z testów native/Rust nie kompilowano ani nie
wykonano. Ten WIP **nie jest podłączony** do public producer/artifact
workflow, nie naprawia jeszcze dwóch solve w dotychczasowej publicznej
ścieżce V/J/H. Typed current-driven closure/source cuts, whole-source
Oersted ownership oraz odpowiednie kwalifikacje pozostają w T05/T06.
Nie zawężono T00–T18. Zmiany ABI/consumer nie należą do żadnej z dziesięciu
wcześniejszych kapsuł; wymagają nowego snapshotu i osobnych dowodów.

**Snapshot ABI/consumer 2026-10-04.** Job
`fc252f8c38c74fb7ba8678a5c355d2d5`, request
`antenna-t06-accepted-charge-canonical-record-abi-consumer-20261004`,
profil `fem-cpu-release`, stan po capture **queued**. Source digest
`c2c98ae34b0df784574b22bbc213d791e86243cd77d3915c29b17ab80c232c10`,
capture `cd5e68cf2d1c4d0e86b31482bf559324`, native source identity
`e1fa90ac13a434ee5e14d34b1e0f25532769195856b297594831b873ed78a03a`.
Obejmuje nowe C ABI i production C/Rust layout assertions, retained
exact bytes, Rust wrapper/decoder oraz opisane source regressions
i wcześniejsze prerequisites. Nie obejmuje późniejszej public
producer/closure integration ani qualification. Ten wpis dopisano
po capture; nie jest częścią wskazanego source digestu.

Przed capture focused scientific validator, `rustfmt --check` dwóch
nowych plików Rust, tracked `git diff --check` i whitespace 12 nowych
plików native workflow/Rust consumer dały exit 0. `rustfmt` nie jest
typecheckiem. Nie uruchamiano cargo/cmake ani native unit buildów.
Ostatni odczyt poprzedniego physical-terminal-adapter job
`1a11fc90b5224311ad01c4a01a2ac164`: **running**, bez końcowego receipt.
Jego status nie dowodzi nowego ABI; zakres każdej kapsuły pozostaje
odrębny. Brak nowego succeeded builda tego fragmentu oznacza WIP,
nie ukończony fragment do commita lub promocji T05/T06.

**Checkpoint źródłowy 2026-10-04 — finalizacja finite external-lead source.**
Po kontrakcie naukowym `antenna-accepted-external-electrode-truncation`
wdrożono prywatny `AcceptedExternalLeadCurrentSource::Finalize` w native
workflow. Przyjmuje istniejący immutable `AcceptedTerminalChargeSource`,
actual source SHA pin, jawne rozłączne stable-ID partycje device/lead,
exhaustive actual exterior roles i device-port observations. Każdy tet
należy w całości do jednej partycji; retained interfaces mają first=device,
second=lead. Każdy electrical component jest niezależnie sprawdzany
przez actual topology z pair adjacency i bijekcję H1 component map.
Wymaga device+lead+interfaces i co najmniej dwóch outer terminali,
wyłącznie na lead. Wariant odrzuca source cuts i samodzielne floating bodies.

Numeric projection zatrzymuje dokładne terminal face groups/RHS i explicit
interface maps; `measure_terminal_current_projection` ponownie całkuje
Piola flux z niezmienionego owned RT0, sprawdza każdy element/interior/
insulating/interface oraz każdy terminal przez lokalne SI gates.
Workflow mierzy osobno H1 `-sum(KV)` i RT0 outward każdej gałęzi, także
requested-zero; wszystkie pary należą do dokładnie jednej obserwacji,
różne obserwacje nie współdzielą device vertices. Niezgodny naturalny
podział prądu zostaje odrzucony, bez rescale lub dodatkowego charge solve.
Rzeczywiste KKT residual/correction i pełny terminal rank ledger pozostają
w tym samym ownerze. Nie powstaje druga mesh/FE-space/GF/P1 ani drugi RT0.

`evaluate_accepted_external_lead_field` całkuje dokładnie ten RT0 i zwraca
fixed scope `external_electrode_truncation`, charge/source/operator
identities i exact retained field bytes/SHA z ordered targets, policy,
H i diagnostyką. Legacy view identity pozostaje pusta. Przed kernelem
obowiązują order 2–16, depth 0–6, pairs 1–1e6 oraz overflow-safe preimage
128 MiB gate (252 bytes/target + 176 bytes diagnostics po header).
Review wykrył nieograniczony order/depth oraz zbyt późny field-record gate;
oba poprawiono, ponowny read-only review nie wykazał nowego must-fix.
Istniejący kernel floor 1 A/m jest jawnie serializowany i udokumentowany,
**nie** nazywany standardowym small-field relative/global error certificate.
Jego zastąpienie i kwalifikacja error budget pozostają wymaganiem T06.

Called-main source regression
`accepted_external_lead_finalizer_preserves_owned_series_and_rejects_foreign_descriptors`
ma three-cube lead-device-lead, analytic R=3/(sigma*scale), sign/reversal/
zero/nano, same owner/mesh/P1/GF/DOFs/rank/diagnostics, lifetime, independent
retained source i field SHA, target/options identity invalidation oraz
konkretne descriptor/policy/preimage refusals (600000 targets przed kernel).
Regresji **nie kompilowano ani nie wykonano**. Focused science/source-map
validator i tracked diff whitespace przeszły exit 0; nie są numerical PASS.
Public ABI/producer nie został podłączony, dwa legacy solve nie są naprawione.
Brak dowodu meshera braku nakładania volumes, complete-loop/truncation
qualification, actuator→branch inverse control, nonzero source cuts i
native/runtime/browser qualification pozostają jawnie otwarte w T05/T06.
Pełny T00–T18 nie został zawężony ani oznaczony jako ukończony.

**Weryfikacja wcześniejszej kapsuły physical-terminal adapter.** Job
`1a11fc90b5224311ad01c4a01a2ac164` zakończył się `succeeded`, exit 0.
Receipt ma wszystkie trzy etapy exit 0; native-build ukończono
`2026-10-03T23:11:07.717438Z`, frontend-dependencies
`2026-10-03T23:28:08.207751Z`, frontend-build
`2026-10-03T23:35:22.68782Z`. Niezależnie sprawdzono sizes i SHA-256
**109/109** artefaktów. Source digest
`84f8ea635698824e9359324b6ef2ff66c0ed861b9f41989cf492a85335559263`,
native source snapshot
`634710a3c80c40bb6b1e9117c956a5b3cd3cd0a0cee3cf09895066cb09318742`.
Pole `native_source_identity_sha256` receiptu jest odrębnym hashem
serializacji identity; nie należy mylić go z `source_snapshot_sha256`.
Receipt zachowuje `qualification=NOT VERIFIED`. Build obejmuje prepared
response/physical terminal adapter/face-closure fixes, **nie** późniejsze
terminal RT0, owned interfaces/digest/ABI ani dzisiejszy finalizator.
Nie powtarzano hashowania niezmienionych wcześniej zielonych kapsuł.

**Snapshot finalizatora 2026-10-04.** Job
`87b18a52c0af4c78b1d363977b5e3650`, request
`antenna-t06-accepted-external-lead-source-finalizer-20261004`, profil
`fem-cpu-release`, stan po capture **queued**. Source digest
`19814926b21cdd09e8875d07665f980548d54c5cf1fdba9447f04c2cca221d60`,
capture `476d6bba23b642cf950f24f610839e96`, native source snapshot
`6f05429e0cdfcca2376fd4c954806b0b1007da98109ee6f1624f520953e59f38`.
Obejmuje wszystkie dotychczasowe prerequisites, nowy measurement/finalizer/
field wrapper, CMake linkage i source regression, wraz z notą, source mapą
i checkpointem sprzed capture. Nie obejmuje tego dopisanego wpisu ani
późniejszej integracji/kwalifikacji. Zapisy wszystkich agentów były
zamrożone. Focused validator, tracked diff check i whitespace **16/16**
untracked native/Rust sources dały exit 0. Nie kompilowano ani nie
uruchamiano testów native. Read-only final review potwierdził preflight
252 bytes/target + 176 bytes trailer oraz brak nowego must-fix; nie jest
to compile/runtime/scientific PASS.
Ostatni odczyt wcześniejszych kapsuł: terminal RT0 job
`38281c8458104515a8bebeb4c2a6a56c` **running**, ABI/consumer job
`fc252f8c38c74fb7ba8678a5c355d2d5` **queued**. Następny krok pozostaje
w pełnym planie: current-driven closure/source-cut i branch control,
whole-source ABI/public producent zamiast dwóch legacy solve, następnie
numeryka/runtime/UI oraz kwalifikacja pola. Nie promować finite contribution
do pełnego closed-loop asset ani bazy LLG na podstawie tych buildów.

**Checkpoint źródłowy 2026-10-04 — jeden bundle V/RT0/H.**
Po kontrakcie `antenna-accepted-external-lead-bundle-abi` dodano append-only
`fullmag_fem_solve_accepted_external_lead_field_v1`: AMD64 request 496 bytes,
boundary 40 bytes, branch 32 bytes i odrębny result 656 bytes. Wcześniejsze
charge/RT0 layouty pozostają niezmienione. Wspólny importer tylko waliduje
i utrzymuje owned mesh/input maps; nowy native workflow tworzy jeden
accepted charge owner, sam ustala jego SHA pin, finalizuje i całkuje ten
sam RT0. Nie wykonuje drugiego legacy charge workflow ani capacity probe.
J ma jawną reprezentację owned RT0, nie nodalny raw J pierwszego solve.

Canonical bundle zawiera trzy dokładne retained binary records i ich SHA,
z aggregate preimage gate 128 MiB przed złożeniem pakietu. Source/field
cross-digests wiążą charge i finalizer; scope pozostaje wyłącznie
`external_electrode_truncation`. C ABI waliduje outer/nested headers,
reserved fields, typed partition/role/branch maps, bounded targets/options,
GPU unavailable i caller buffer. Dopiero po pełnym sukcesie publikuje len
i identity; truncated prefix nie otrzymuje pełnych zapisów. Prywatny Rust
adapter wykonuje jedno FFI, niezależnie dekoduje framing/hash/request binding
V/material/RT0, source i ordered H/policy/diagnostics. Shared callback pack
nie wywołuje solve. Nie jest podłączony do publicznego producenta.

Main review poprawił outer `operator_version` oraz mapping H1 component
gauge label→minimum stable vertex ID finalizatora; nie są to równe ID.
Końcowy review wykrył dalsze must-fix: abs-only RT0 face binding i zwykłą
sumę f64 przy silnym znoszeniu prądów. Snapshot wstrzymano do ich naprawy;
obie poprawki są teraz zapisane i ponownie przejrzane źródłowo.
Kontrakt `antenna-external-bundle-signed-ledger` wersjonuje source record
do ordered.v2/operator.v2. Native measurement już publikuje rzeczywisty
signed Piola DOF→canonical flux weight, zero-safe bez ilorazu przez q,
z lokalnym adjacent-element SI gate i niezmienionym GF. Consumer wiąże
ten signed ledger z elementami, terminalami, interfaces i insulation,
stosując sumowanie Neumaiera bez poszerzania fizycznych gates. Main naprawił
również const access do cached MFEM transformation; mesh/GF pozostają te
same. Końcowy read-only review nie wykazał dalszego must-fix w signed
map/side ordering/agregatach, ale nie obejmował wykonania.

Niepoprawny wcześniejszy two-tet codec fixture został zastąpiony trzema
kostkami: 24 vertices, 18 tet, 54 faces, 36 exterior faces, sigma 1 S/m,
analityczny V/J i H=0 na osi symetrii mimo niezerowego RT0. Oddzielono
disjoint electrode/trace oraz branch reaction DOFs. Main/review poprawił
także rank ledger: 18 divergence + 4 pair + 2 terminal rows = 24,
rank 23, omitted `terminal-current:ground`, reason 2 i zero anchor.
Decoder sprawdza liczbę wierszy z actual NE/interfaces/terminals przez
checked arithmetic; nie powiela w Rust native exact-rank algorytmu.
Regresje źródłowe obejmują poprawny bundle baseline, fully-rehashed nonzero
q sign flip, weight/scales/outward/rank i invented row count, field
targets/policy/diagnostics/framing oraz overlapping support. Cancellation
regression bada pomocniczy Sum (1,2^-54,-1); nie jest pełnym cancellation
bundle testem. Codec weight=2 jest syntetyczną kalibracją, **nie** dowodem
normalizacji MFEM. Wszystkie te regresje pozostają niekompilowane.

Called-main ABI source fixtures mają real three-cube series, independent
outer/nested framing/SHA, analytic V, signed H1/RT0, H reversal/doubling/
zero, determinism/lifetime i atomic failure/canaries. Odd linearity gate:
1e-8 A/m + 1e-4 max(|expected|,|measured|), nie globalna policy błędu pola.
Regresje **nie są skompilowane ani wykonane**. Dotychczasowy focused
scientific validator i tracked diff check mają exit 0. Header-derived
ctypes sprawdził sizes/alignment/offsets pięciu layoutów na AMD64; jest
to interpretowana kontrola deklaracji, nie native compile proof.
Rustfmt/parser checks również nie są typecheckiem. Native unit build ban
pozostaje w mocy, pełny T00–T18 i public/runtime/physics gates są otwarte.

**Zweryfikowana wcześniejsza kapsuła terminal RT0.** Job
`38281c8458104515a8bebeb4c2a6a56c` ma teraz `succeeded`, exit 0;
receipt trzy stages exit 0, native-build zakończony
`2026-10-04T00:09:05.859187Z`, frontend-dependencies
`2026-10-04T00:25:37.20968Z`, frontend-build
`2026-10-04T00:32:52.298259Z`. Niezależne sizes/SHA **109/109** artefaktów
przeszły. Source digest
`b7261ddd1963b1475ca935ba3a04503b63890ef9d20d221adac894ccf6a7c03b`,
native snapshot
`37f4e049327f80a0176f368197aa6c18c98c1143b617dd0a5e1ca71140f1aa4c`.
Receipt nadal `qualification=NOT VERIFIED`; jego diagnostyczne probes
wersji cargo/rustc mają permission errors, mimo sukcesu właściwych stages.
Dowód obejmuje pierwotny terminal-constrained RT0 i finite/NC preflight,
**nie** późniejsze owned interfaces/digests/ABI/finalizer/bundle ani poprawkę
signed v2 ledger. Nie hashowano ponownie wcześniejszych zielonych kapsuł.

**Nowa niezmienna kapsuła bundle/signed ledger — zlecona, nie zbudowana.**
Po zamrożeniu zmian i final source review zlecono profil `fem-cpu-release`
przez istniejącą kolejkę Fullmag_build_runner: job
`d7bc7fc32e024171add390d8eb451278`, request key
`antenna-t06-external-lead-owned-bundle-signed-ledger-20261004`, capture
`59a581a8f14843d2a053e6fc2964928a`, ostatni stan **queued**.
Source digest
`85e503e3a0aba04555e364e8025bb68d29ae88e74b95dc3781c208565af06fcb`,
native source snapshot
`72b802a9c2020709b7dcc061ea73d202a63362cdc1a7a1888a9c888b8c98dfdd`.
Klient uwzględnił 26 untracked source inputs. Niezależne porównanie SHA-256
**15/15** core ABI/native/Rust/regression files z protected capsule tree
potwierdziło zgodność z zamrożonym kodem. To dowód capture, **nie** build,
unit execution, runtime, render ani scientific PASS. Nie uruchomiono
równoległego host builda i nie kompilowano unit tests.

Końcowe lightweight gates: focused validator noty 0950/source-map exit 0,
tracked i 26 untracked diff whitespace checks exit 0, rustfmt check trzech
nowych Rust plików exit 0; parser-only emit dla FEM FFI/native module oraz
charge pack/record exit 0. Nie utożsamiać parsera z typecheckiem. Ten wpis
metadanych powstał **po capture** i nie twierdzi, że cała bieżąca dokumentacja
ma ten sam source digest. Kolejna bramka tej kapsuły to receipt, exit codes
stages i sizes/SHA artefaktów; kolejny fragment implementacji to jawne
materialized maps public producer, nie częściowa podmiana jednego V/J/H.

**Audyt następnego przyrostu — publiczny producent i brakujące mapy.**
Read-only audit i odczyt call sites potwierdziły, że
`crates/fullmag-runner/src/native_fem/charge_transport.rs::execute_native_fem_charge_transport`
nadal wykonuje device-only charge dla V/raw nodal J oraz drugi closure
charge/RT0/H workflow. Dostępność prywatnego bundle ABI tego nie naprawia.
Poniższe ustalenia są evidence-backed opisem bieżących źródeł, nie nowym
publicznym API ani zatwierdzonym runtime.

| Warstwa / actual symbol | Dane istniejące | Luka przed jednym bundle |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/current_transport.py::ConservativeCurrentLeadInterfacePair` | dwa sorted stable face keys | brak pair ID i exact vertex bijection; zip posortowanych IDs nie jest mapą fizyczną |
| `crates/fullmag-ir/src/spin_transport.rs::ConservativeCurrentClosureIR::ExternalLead` | lead mesh/sigma/stable IDs, face pairs, dwie outer electrode face groups, voltage drop i drive/revision/digests | brak signed outer current actuators i terminal observation→pair groups; stare voltage closure nie może zostać reinterpretowane |
| `crates/fullmag-ir/src/spin_transport.rs::ResolvedFemConservativeCurrentViewIR` | device stable IDs i boundary roles/keys/pins | trzeba jawnie połączyć actual device+lead topology/material/partitions/roles i zachować provenance, nie dorabiać brakujących map z geometrii |
| `crates/fullmag-ir/src/antenna.rs::ResolvedAntennaPortBranchIR` | branch ID, inlet/outlet terminal refs, signed weight | public branch ma dwa końce; native observation jest jedną grupą outward current. Inlet i outlet muszą pozostać dwiema obserwacjami o przeciwnych znakach |
| `crates/fullmag-runner/src/antenna_field_solution.rs::AntennaFieldBasisInput` | device nodal V/J i sampled H, wspólna current normalization | bundle ma combined P1 V i RT0 coefficients/maps. Potrzebny versioned carrier, nie podstawienie RT0 moments pod nodalne J ani zachowanie J z pierwszego solve |

`crates/fullmag-plan/src/mesh.rs::merge_fem_meshes` zachowuje jawne segment
offsets/counts obiektów; nie określa physical device↔lead correspondence.
`charge_transport.rs::requested_antenna_terminal_currents` nadaje już
inlet/outlet przeciwne signed currents. Resolver nie może zsumować obu
końców w jedną observation, bo zgubiłby prąd przez skasowanie znaków.
Native finalizer tylko mierzy i sprawdza naturalny podział: dwie outer
electrodes nie zapewniają dowolnych wag wielu returns. Niedostępna topology
sterowania musi być odrzucona albo otrzymać osobny inverse-control/rank
kontrakt; rescale nie zastępuje brakujących actuators.

Najbliższy bezpieczny przyrost, z verification gates dla każdego kroku:

1. Wersjonowane current-driven post-meshing Python→IR input: pair IDs/
   bijections, outer current actuators i osobne inlet/outlet observations.
   Sprawdzić exact round-trip i zachowanie rozpoznawalnej legacy voltage
   semantyki; brak silent reinterpretation.
2. Planner materializuje combined mesh/sigma/stable IDs/partitions/roles
   i request pins. Sprawdzić complete coverage, bijections, overlapping
   volumes, shared essential/reaction DOFs oraz unsupported control topology.
3. Typowany resolver buduje existing `AcceptedExternalLeadRequest` bez
   wywołania legacy charge i bez rescale. Sprawdzić każdy request field
   względem canonical post-meshing input, także signed observation lineage.
4. Versioned publisher zapisuje exact bundle bytes/SHA, osobny RT0 carrier,
   combined ordering/partition i jawne device-V selection. Jeśli potrzebne
   J do viewportu, jego sampling/projection musi mieć nazwaną i kwalifikowaną
   realizację, jednostkę oraz provenance. Nie wkładać RT0 moments w stary J.
5. Dopiero wtedy jednocześnie zastąpić całego V/RT0/H producenta. Zachować
   `external_electrode_truncation`; nie promować do `closed_loop` lub bazy
   LLG. Jawny `VectorPotentialSolver` nie może przejść na direct quadrature;
   pair budget obejmuje device+lead elements. Wymagane osobne managed,
   numerical/scientific, runtime/LLG i UI gates pozostają otwarte.

Przy projektowaniu kolejnego ABI consumer musi móc sprawdzić nie tylko
tekstowy digest, lecz zgodność publikowanych pól z jego preimage.
Sam poprawny hash opaque bytes z obok zwróconymi niesprawdzonymi V/RT0
buffers nie poświadcza tych buffers. Layout musi zatem przenieść
komplet potrzebnych actual topology/face-DOF/sign/policy/rank danych
lub jeden kanoniczny record, z którego consumer dopiero buduje wynik;
nie wolno zgubić mapowań potrzebnych do rekonstrukcji tego schema.
Capacity/length/reserved/version gates muszą poprzedzać publikację,
a błąd zerować wszystkie published lengths i identity. Native unit
kompilacja pozostaje zakazana; source regression nie jest dowodem
wykonania ABI, a przywrócenie takich testów wymaga odwołania zakazu.

**Pliki:** istniejące `conservative_current_view` i `oersted/direct_tetra_quadrature.*`, `backends/fem/tests/oersted_direct_tetra_contract.cpp`, nowy `tests/antenna/verify_field_convergence.py` oraz fixtures pod `tests/antenna/fixtures/`.

**Checkpoint źródłowy 2026-10-04 — current-driven input bez legacy fallbacku.**
Dodano addytywne `CurrentTransport.conservative_current_source`, schema
`conservative_current_source.v1`, pięć publicznych Python klas i odpowiadające
typed IR. Jawne pair IDs/bijections, outer signed-current actuators,
oddzielne inlet/outlet observations oraz per-mode drives zachowują się przez
global wrapper, StudyBuilder, import sceny i canonical script export.
Source-specific gates wymagają static one-way H1/cg, empty BC,
terminal-reference, actual lead exterior i zgodnych Python/IR limitów.
Legacy voltage/view nie jest reinterpretowany. Płaski IR propaguje błędy
non-null source, zachowując legacy absent/null; dodano źródłowe regresje
scalar/list, unknown fields i incomplete definition.

Wykonane Python checks: **76 passed, 91 subtests passed, exit 0**, pięć plików
`test_current_source.py`, `test_current_transport.py`,
`test_structured_current_closure.py`, `test_scene_document_roundtrip.py`,
`test_script_builder_roundtrip.py`, środowisko contract-python na D.
To dowód authoringu, nie wykonania charge/H. Dodane regresje Rust/IR/API nie
były kompilowane ani wykonywane zgodnie z obowiązującym zakazem unit builds.
Planner, binder i runner odmawiają execution nowego source **przed** legacy
charge/prescribed/voltage ścieżką. Public single-bundle producer pozostaje
niepodłączony; generated OpenAPI wymaga regeneracji z nowego zbudowanego
schema emitter. Nota 0950 obejmuje 23 nowe publiczne parametry, SI,
Python→IR, actual source/test index i rozróżnienie input/output pins.

Następny przyrost: mesh-exact dedicated planner materializer, request pins,
selected drive i dwie observations każdego branch → jeden typed bundle
request → nowy versioned RT0/P1/H publisher. Do jego ukończenia nie wolno
usuwać bramek odmowy ani publikować starego device-only V/nodal J obok H
z nowego bundle. `external_electrode_truncation`, combined pair budget i
odmowa explicit vector-potential fallback pozostają obowiązkowe. T05/T06
nie są ukończone; runtime, nauka, LLG oraz browser pozostają oddzielnymi
bramkami.

**Niezmienny snapshot nowego input — capture potwierdzone.**
Job `baf4107d7372486da5d4d69790df1b03`, request key
`antenna-t06-current-driven-source-authoring-20261004`, profil
`fem-cpu-release`, stan przy przyjęciu **queued**. Source digest
`7e7999d115203e50d75d80d0cd3d371dfe7bead575e4095753d9d7bb74c859ad`,
capture `b5b8ec0b127a45b39fda9f427b392fbb`, native source snapshot
`2ec6270ebcf384bb6481406dfc9be340ee36951dc11668d2915a8d81d3c1857c`.
Włączono jawnie 27 untracked inputs; niezależne SHA-256 porównanie **19/19**
core Python/IR/authoring/planner/runner/API files z protected capsule tree
potwierdziło zamrożone źródła. Focused validator noty/source-map, tracked
diff check, check nowego Python regression i Rust format/parser-only checks
zakończyły się exit 0. Parser nie jest typecheckiem. Capture nie obejmuje
późniejszego kontraktu materializacji ani tego wpisu metadanych; nie ma
jeszcze receipt potwierdzającego build tej kapsuły. Nie kompilowano unit
tests, nie uruchomiono native solve ani równoległego host builda. Chwilowo
zajętą blokadę storage uszanowano; zgłoszenie przyjęto dopiero po jej
zwolnieniu, bez kasowania locka.

**Potwierdzony wcześniejszy build owned charge — 2026-10-04.**
Job `fb6dde484c914e73914d2947ca239fe9`: `succeeded`, profil
`fem-cpu-release`, receipt `fullmag.local-runner.build-receipt.v1`,
source `2dd02d361a733d5ce5364b5dcbdeb2b0d452e4d2425e39c4f5fb73791147d504`,
capture `817b31b2bc15470fb2c9f890f538dcdb`, native source snapshot
`abaa2732a7153ff8c3e80ea4872d83879728d3613755a6a2ce6596a9fa9340e2`.
Trzy etapy native/dependencies/frontend mają exit 0; receipt zakończony
`2026-10-04T01:31:10.801277Z`. Niezależnie zweryfikowano rozmiary, SHA-256
i containment **109/109** artefaktów względem katalogu `artifacts` tego joba.
Receipt nadal podaje qualification `NOT VERIFIED`. Ten build nie obejmuje
nowego current-driven input ani późniejszego bundle/signed-ledger capture;
nie dowodzi wykonania testów, native solvera, physics ani browser.

**Checkpoint źródłowy 2026-10-04 — mesh-exact wejście dedicated source.**
Dodano osobny `ResolvedAntennaExternalLeadCurrentInputIR` oraz
`materialize_antenna_external_lead_current_input`, bez mieszania z legacy
charge planem. Sprawdzane są rzeczywiste Tet4/exterior Tri3, complete
immutable object ownership, scalar sigma, jawne contact bijections,
binary64 coincidence/opposite sides, device/lead partition i bilans
prądów osobno dla actual P1+interface komponentów. Combined mesh zachowuje
xyz, markery, kolejność komórek i stable IDs; offset dotyczy wyłącznie
lokalnego connectivity. Original metadata/ordinals pozostają w osobnych
snapshotach. Wybrany drive pokrywa wszystkie source observations bez
inferowania brakujących actuatorów lub zero RHS.

Niezależny source review wykrył i poprawiono trzy native-fit luki:
`max_iterations<=INT_MAX`, checked sumę terminali minus reference per
component `<=64` i inverse essential-P1 electrode closure na actual lead
exterior. Fully-essential mixed separator jest odrzucany, free vertex
pozostaje dopuszczalny. Dziewięć regresji Rust zapisano w źródle; **żadna
nie była kompilowana ani wykonywana**. Powtórny przegląd tych trzech gates
nie wykazał dodatkowego blockera. To nie dowód conditioning lub poprawności
całego native solve.

Input pins używają bounded canonical JSON z recursive key ordering,
finite metadata i streaming count preflight 128 MiB przed dużą alokacją.
Nie są SHA przyszłego wyniku ani kwalifikacją peak RAM. Direct policy
zachowuje istniejące wartości order/depth/absolute/relative/pair budget,
oznaczone `external_lead_direct_defaults.unqualified.v1`. Explicit vector
potential i forced GPU nie mają CPU/direct fallbacku. Source branch w
`plan_antenna_field_solve_v03` materializuje wejście **przed** legacy resolverem,
a następnie nadal zwraca `unavailable`: producent i publisher niepodłączone.

Następny krok to owned standalone binary reader, niezależny od borrowed
request, zachowujący partitions/roles/observations/target/policy i gauge/
omission certificates; osobno binding do rzeczywistego request/pinów.
Docelowy `antenna_external_lead_solution.v1` pozostaje **planowanym**
inspection-only artefaktem raw combined V [V], RT0 moments [A] i H [A/m],
bez rescale lub odziedziczonego nodal J. Legacy v1 publisher zakłada nodal
V/J i wspólną normalizację per ampere; nie wolno podmienić nim nowego
bundle. Stage API nadal wymaga addytywnego usunięcia obowiązkowego legacy
view selector z nowego authoringu, a OpenAPI nowej generacji i UI wymagają
osobnych przyrostów. T05/T06/T18 pozostają otwarte; brak native unit,
runtime, fizyki, LLG, FFT i browser dowodu nie jest zamieniany w procent
ukończenia.

**Niezmienny snapshot materializatora — przyjęty 2026-10-04.**
Job `43e61c9ff44a4c8a92850ea0f0d02779`, request key
`antenna-t06-current-source-materializer-20261004`, profil `fem-cpu-release`,
stan przy przyjęciu `queued`. Source digest
`39ff75fe035b76e17ce35b62b9943aa769d723d379563b39a77bff03fb63330f`,
capture `e3c30d03ed83409a84ab475ab552cd10`, native source snapshot
`1a508c36c04d1b137ac9d245813825bf28f59e3820ab40c4d84a74d42c926362`.
Jawnie włączono 29 untracked inputs; SHA-256 porównanie **10/10** core
materializer/IR/planner/docs files potwierdziło protected capsule tree.
Focused scientific validator, new-file Rust format i modified-module
parser checks oraz scoped whitespace checks mają exit 0. Niezmienione
Python authoring 76+91 i wcześniej zielone 32 tests validatora zachowują
swoje dowody; nie uruchamiano ich ponownie bez zmiany tych źródeł.
Capture nie obejmuje tego wpisu metadanych ani późniejszej implementacji
owned standalone readera; nie ma jeszcze receipt bieżącego materializatora.

**Potwierdzony wcześniejszy build typed interfaces — 2026-10-04.**
Job `b9fdd2c8f0d345b98d8ee5808c14c904` zakończony `succeeded`, exit 0,
profil `fem-cpu-release`, receipt `fullmag.local-runner.build-receipt.v1`.
Source `ba11e88bfbf3cbc47cd0b855b7521f437fce248eee7c137638b453b7e492f9f8`,
capture `51002f1a794d496b801b2c46304a442d`, native source snapshot
`9699dba704ab49e94c8a3c855f919b1361a0847ae94478bacdd51dbc6293425c`.
Tożsamość kolejki/source/native receipt i trzy etapy exit 0 są zgodne;
zakończenie receipt `2026-10-04T02:31:01.314836Z`. Niezależnie sprawdzono
containment, rozmiary i SHA-256 **109/109** artefaktów. Qualification
pozostaje `NOT VERIFIED`; build nie obejmuje późniejszego authoringu,
materializatora lub readera i nie dowodzi runtime/testów/fizyki/browsera.

**Checkpoint źródłowy 2026-10-04 — standalone reader i fizyczna spójność.**
Materializator ma dodatkową kontrolę bijekcji actual face-connected
components + typed interfaces z komponentami P1. Styk przez sam vertex
lub edge nie może zwierać objętości. Dodana regresja ma poprawny baseline
oraz dwa dodatnio zorientowane actual Tet4 połączone wyłącznie punktem
albo krawędzią; liczba funkcji regresyjnych materializatora wynosi obecnie
10. Niezależny source review sprawdził tę kontrolę bez dodatkowego blockera.
Snapshot `43e61c9ff44a4c8a92850ea0f0d02779` **nie obejmuje** tej późniejszej
kontroli ani poniższego readera; ostatni odczyt jego stanu to `queued`.

`decode_owned_bundle` odczytuje bounded exact bundle bez borrowed request
i bez native solve. Zachowuje source/field jako zakresy exact bytes w
owned payload, charge bytes, partitions/roles, requested/H1/RT0 observations,
element/face ledger, targets/policy/H/diagnostics i charge reference/gauge/
component/omission metadata. `validate_bundle_request` jest osobną kontrolą
rzeczywistego charge/material/ordering/closure/roles/branches/target/policy.
Wrapper zachowuje dotychczasowe odmowy bez phantom request. SHA dowodzi
tożsamości bytes, nie aktualności modelu, autentyczności ani ponownego
obliczenia skończonego H. Limit recursive refinement wynika z actual
ośmioramiennego drzewa native quadrature, nie z liczby pierwotnych pairs.

Review znalazł jeszcze geometry integrity gap: exact coincidence
interfejsu nie dowodzi przeciwnych stron sąsiednich tetraedrów; zero-current
ledger może ukrywać overlap po tej samej stronie. Poprawka przed graph
union używa jednego physical triangle ordering z jawnej vertex bijection
i istniejącego signed geometry helpera. Zero-current reflected-lead
regresja przelicza wszystkie SHA i wymaga konkretnego geometry error;
permuted-ID regresja zachowuje poprawną geometrię mimo odwróconej
canonical-ID orientacji. Powtórny niezależny source review nie znalazł
dodatkowego blockera w tej poprawce. Siedem nowych funkcji readera i 10
funkcji materializatora **nie były kompilowane ani uruchamiane**.

Scientific note 0950, complete reader parameter table i actual path+symbol
source-map/index zostały uzupełnione; focused validator ma exit 0. Osobny
kontrakt `antenna-current-source-stage-selector` zapisano przed następną
migracją: `Option<String>` / `str | None`, canonical omission i brak
selector tylko przy typed source w dokładnie wskazanym module. Legacy
identyfikatory pozostają zachowane; blank nie jest poprawnym sentinelem.
Implementacja tej migracji jest w toku; generated OpenAPI i UI nie są
ręcznie patchowane ani przedstawiane jako gotowe.

Producent, nowy `antenna_external_lead_solution.v1` publisher, manifest
input-pin binding, derived H/xyz data plane oraz consumer qualification
pozostają do podłączenia. Inspection-only raw V [V], RT0 [A] i H [A/m]
nie mogą zostać podmienione pod legacy nodal/per-ampere v1 lub dopuszczone
do LLG/FFT. T05/T06/T18 pozostają otwarte; źródłowa kontrola i kolejka
buildów nie są native/runtime/scientific/browser PASS.

**Zamrożony przyrost 2026-10-04 — optional selector i końcowe lekkie bramki.**
Migracja zakończona w Python, IR i resource schema: `Option<String>` /
`str | None`, default None, absent/null canonicalizowane do pominięcia pola.
`validate_stage_current_view_ref` jest podpięte do obu actual validator
entrypoints. None jest dozwolone tylko dla typed source w dokładnie
wskazanym module; source z innego modułu, brak legacy selector i present
blank są odrzucane. Rust zachowuje dokładny nonempty Some; Python zachowuje
dotychczasowe strip normalization, nie deklaruje byte preservation
nieznormalizowanych whitespace. Pure source materializer ma własny gate
przed pins oraz source regression None/historical/blank. Liczba jego
funkcji regresyjnych to obecnie **11**, bez ich kompilacji/wykonania.

Niezależny source review nie znalazł blockera migracji. Wykonano łączną
lekką kontrolę siedmiu plików Python po zmianie authoringu/exportu:
`test_current_source.py`, `test_current_transport.py`,
`test_structured_current_closure.py`, `test_script_builder_roundtrip.py`,
`test_scene_document_roundtrip.py`, `test_antenna_composition_contract.py`
i `test_antenna_stage_workflow.py`: **105 passed, 91 subtests passed**,
exit 0, 4.32 s. Użyto istniejącego interpretera/env na D: i D: TEMP,
bez instalacji lub nowych cache na C:. Poprzednie 29 tests było podzbiorem
tego wyniku, nie osobnym dodatkowym zestawem. To authoring/serialization
proof, nie native typed-source wykonanie.

Focused science/source-map validator, końcowe scoped Rust format/parser
i whitespace checks mają exit 0. Niezależne obliczenie samej geometrii
three-cube fixture potwierdziło 18 dodatnio zorientowanych Tet4, cztery
opposite interfaces oraz dwa same-side interfaces po odbiciu left lead.
Nie wywoływało readera, solvera ani kwadratury i nie zastępuje regresji Rust.
Generated OpenAPI, generated TS/UI i cały nowy publisher pozostają pending.
Wszystkie zapisy subagentów zamrożono przed kolejnym snapshotem.

**Potwierdzony wcześniejszy build content-digest — 2026-10-04.**
Job `a6330583011b4353aaffb8d2cdde9be1`: kolejka `succeeded`, exit 0;
receipt `fullmag.local-runner.build-receipt.v1`, trzy etapy exit 0.
Source digest
`8120ca24f901384e5cff4d46f9f69e7d052e827cecc05c6e2563e475482aa167`,
capture `cc098bed112d40e29180e94ce842d1f6`, native source snapshot
`21440f999fd217f364ffb4ece52b90d0934c196e1cef15e8d22eb86311dcdc68`,
receipt finish `2026-10-04T03:30:23.442341Z`.
Sprawdzono queue/receipt/source identity, containment, rozmiary i SHA-256
**109/109** artefaktów. Qualification pozostaje `NOT VERIFIED`. To starszy
snapshot content-digest, nie obecny standalone reader, czwarty physical/P1
gate, materializator z optional selector ani aktualna migracja API.

**Niezmienny snapshot readera, geometrii i optional stage — 2026-10-04.**
Job `b600b59989d649b6bdc098331c488153`, request key
`antenna-t06-owned-reader-physical-graph-optional-stage-20261004`, profil
`fem-cpu-release`, stan przy przyjęciu **queued**. Source digest
`35ddfb798d61ce055d9c8b79f059db54aa379483938b9c656377e36ed5b937da`,
capture `a605183265b4471d9af62c4413610e8b`, native source snapshot
`1c95bff147e18c793113be29d37d977b189c2b992ae7d3de4c015dcbe5d163d5`.
Jawnie wskazano wszystkie 29 untracked inputs. Niezależne porównanie
SHA-256 **22/22** core files potwierdziło zgodność protected capsule tree
z zamrożonymi źródłami: reader i jego 7 nowych regresji, physical/P1 gate,
materializator, optional-selector IR/Python/resource, libs/field planner,
powiązane fixtures, nota/source-map i plan. Capture zawiera poprzedni
checkpoint 105+91 oraz receipt wcześniejszego content-digest buildu, ale
**nie ten późniejszy wpis własnych metadanych**. Nie ma jeszcze receipt
buildu tego snapshotu; przyjęcie do kolejki i zgodność kapsuły nie stanowią
dowodu kompilacji, native runtime, kwalifikacji naukowej lub UI.

**Source-only granica inspekcyjnego artefaktu — 2026-10-04.**
Dodano `antenna_external_lead_solution.v1` w osobnym module runnera:
thin manifest, exact retained raw V/RT0/H bundle i pięć basename-only
binary payloads (bundle, xyz, H, device IDs, device V). Nie ma nodal J
ani per-ampere rescale. Builder wymaga jawnej requested execution,
odtwarza materializator i porównuje cały actual input/pins, dekoduje
exact bytes i binduje je do rzeczywistego CPU-double native request.
Adapter zachowuje existing native-v1 jump defaults 1e-12 V / 1e-12,
solver tolerances z input, authored revision oraz actual signed maps.
Pure owned codecs dostępne są bez FEM build flag; tylko request/packing/
native solve/binding pozostają FEM-gated. To nie jest nowy solver w FDM.

Inspection loader wymaga zgodnego expected manifest digest, exact nested
SHA, pięciu distinct fixed payload paths oraz bitowej zgodności H/xyz/V
z bundle. Device selection pokrywa exact retained partition; permutation
IDs+V może być spójnym zapisanym wynikiem, ale nie dowodzi aktualności
wobec authored order. Input pins mają prefix `sha256:`, nested result
SHA nie mają prefix. Unknown nested fields nie są ignorowane.
`inspection_only` / `NOT VERIFIED` / `external_electrode_truncation`
pozostają stałe. Legacy LLG/spectrum readers mają early
`source_not_qualified`, przed normalization/projection/FFT.

Atomic publisher ma odrębny namespace
`antenna/external_lead_solutions/<output>/<digest>/`, private UUID temp,
create-new regular files, bounded reads przed allocation, verify przed
rename i exact-byte reuse. Cleanup obejmuje wyłącznie własne newly
created files. Jawne ograniczenia: trusted local writers, nie hostile
filesystem TOCTOU; Windows std nie gwarantuje directory fsync.

Dodano 9 źródłowych regresji loader/publisher, 3 filesystem-helper
regresje i 1 pure-codec refusal bez native request. Fixture reused z
existing independent codec encoder; literal receipt pins są shape-only,
nie proof current-input binding. Wszystkie nowe Rust regresje pozostają
**niekompilowane i niewykonane** zgodnie z zakazem test compilation.
Parser/format i focused scientific-doc validator są bramkami źródeł,
nie managed runtime lub scientific PASS. Public producer→stage/API,
quantity visualization, source qualification i docelowa LLG/FFT
normalizacja nadal wymagają osobnego podłączenia i dowodów. T05/T06/T18
pozostają otwarte; nie nadano nowej capability ready.

Końcowy source check tego przyrostu: format/parser dziewięciu nowych
Rust files exit 0; parser trzech powiązanych istniejących files exit 0;
focused validator 0950/source-map exit 0; scoped tracked diff check
oraz full whitespace scan dziewięciu nowych files exit 0. Independent
source review nie znalazł blockera w boundary/cfg/units/pins/publisher.
Nieblokujący brak domain-ID checks usunięto po review: object/region
IDs wymagają nonblank bounded text bez NUL, z trzema negative cases
w istniejącej regresji. Nie uruchomiono kompilacji/testów Rust ani
nowego native runtime; poprzednie 105+91 Python checks nie były
powtarzane, ponieważ ten przyrost nie zmienia ich źródeł.

**Niezmienny snapshot publishera — 2026-10-04.**
Job `48268507023c413a97f1e9c944769e58`, request key
`antenna-t06-external-inspection-publication-20261004`, profil
`fem-cpu-release`, stan przy przyjęciu **queued**. Source digest
`7f7e72a89e59104a9a9a125d1b30becd0fb7f49f0777a0c4d0d680b93131d499`,
capture `e5cc9e5bef08406795e5ae689e2e038e`, native source snapshot
`32096252bc20ef4115ad6680488ffdcbc8c0407ab1caa4208d967a18591c5362`.
Jawnie wskazano wszystkie **33** untracked inputs. Niezależne SHA checks
**16/16** potwierdziły protected capsule = live core/codec/adapter/hooks/
docs w chwili capture. Kapsuła zawiera poprzedni source-check checkpoint,
ale **nie ten późniejszy wpis własnych metadanych**. Receipt buildu
jeszcze nie ma; queued/capsule integrity nie dowodzą kompilacji.

W tym przebiegu wykryto terminalny failure wcześniejszego joba
`fc252f8c38c74fb7ba8678a5c355d2d5`: kolejka `failed`, exit 2,
source `c2c98ae34b0df784574b22bbc213d791e86243cd77d3915c29b17ab80c232c10`,
capture `cd5e68cf2d1c4d0e86b31482bf559324`. Pełny kontekst stderr wskazuje
Rust E0428: dwie deklaracje `accepted_terminal_charge` w `native_fem.rs`
(linie 16 i 20 starej kopii), końcowo native-build exit 2. Approved
protected-tree read potwierdził **2** deklaracje w failed snapshot oraz
**1** w snapshot b600, nowym snapshot 4826 i bieżącym źródle. Nie retryowano
starej kapsuły i nie uznano static count za proof nowego zielonego builda.

Następny krok T05/T06/T08: podłączyć actual materialized source do jednego
`solve_accepted_external_lead_field`, buildera i atomic publishera bez LLG;
public stage/API muszą przenosić osobny inspection-only reference/status,
nie stary ready field-basis asset. Dalej required: receipt nowej kopii,
native runtime i scientific gates, UI/API data plane oraz świadoma
kwalifikacja pola do LLG/FFT. Nie usuwać source_not_qualified wyłącznie
dlatego, że producer albo build zakończył się sukcesem.

**Checkpoint integracji źródłowej — 2026-10-04: samodzielna inspekcja anteny.**
`plan_antenna_field_solve_execution` rozdziela dotychczasowy field basis od
`ExternalLeadInspection`; wrapper legacy nadal odmawia tej drugiej ścieżki.
Explicit i pipeline authoring używają jednego resolvera akcji CLI. Current-driven
input jest ponownie materializowany i porównywany w całości przed jednym
`solve_accepted_external_lead_field`; producer wymaga strict FEM CPU/auto double
oraz bezpiecznego zadeklarowanego output ID o authored quantity `H_ant_basis`,
tak jak planner. Ta etykieta wybiera wyłącznie nazwę: zapisane H pozostaje
w A/m, V w V i RT0 w A; nie powstaje baza na amper ani `ready`.

Dedykowany stage publikuje istniejący sześcioplikowy immutable inspection
artifact oraz bounded no-overwrite
`antenna_external_lead_stage_output.v1.json`. Reference jest odrębnym
`inspection_ref`, nie legacy `solution_ref`/asset. Failed/cancelled record
ma pustą listę outputs. Cancellation jest sprawdzana przed i po
nieprzerywalnym native solve, przed handoff i publikacją. Już opublikowany
artifact nie jest kasowany po późniejszym cancel. Nie ma wpisu do
`published_antenna_outputs`, projekcji, FFT ani konsumpcji LLG. Planner
odrzuca powiązanych projection/spectrum consumers oraz multi-object source
przed merge, który nie zapewnia stable-ID/marker contract. Jeden oryginalny
mesh może nadal zawierać wiele rozłącznych przewodzących gałęzi.

Obecny session read-model wymaga mesh/material/initial-m carrier. Tymczasowy
bridge re-resolve'uje niesanitizowany oryginał, a dopiero potem planuje lokalną
kopię bez aktywnej fizyki. Zero-Zeeman i syntetyczne controls Heun są wyłącznie
rusztowaniem istniejącego planner vocabulary; nie są uruchamiane ani dodawane
do authored intent. Runtime metadata pokazują inspection CPU/double,
`inspection_carrier_only` i `NOT VERIFIED`, bez pozornej kwalifikacji LLG,
timestepu lub `H_ant_basis`. Magnetyzacja i istniejący equilibrium certificate
przechodzą bez zmiany. Bridge nadal ma typ FEM `ExecutionPlanIR` i dziedziczy
ograniczenia mesh/material/initial-state: docelowy nieegzekwowalny carrier
oraz przypadek bez obiektu magnetycznego pozostają osobną bramką.

Dodano **12 niewykonanych regresji Rust**: 4 public planner, 2 producer guard,
3 stage publication/catalog i 3 carrier. Obejmują requested auto/CPU i actual
disconnected ownership, forced GPU/single/extended refusal, early consumers,
safe/undeclared/wrong-quantity output, cancellation/reuse oraz brak promocji
do legacy catalog. Zgodnie z zakazem nie kompilowano ani nie uruchamiano
testów Rust. Format/parser i skupiony walidator 0950/source-map przeszły.
Niezależny source review potwierdził brak inicjalizacji LLG przed synthetic
branch i wskazał output-quantity guard, który poprawiono. To nadal **source-only**.
Public API kataloguje tylko legacy output; dedykowany inspection resource,
OpenAPI/generated types, binary data plane i UI muszą zostać podłączone
razem, bez adaptera udającego qualified field basis.

**Nowy problem dowodu buildu — stare zależności mimo prawidłowego snapshotu.**
Joby `d7bc7fc32e024171add390d8eb451278` i
`baf4107d7372486da5d4d69790df1b03` zakończyły się `failed`, exit 2.
Pierwszy zgłasza 12 brakujących external-lead ABI names, drugi dodatkowo
2 błędy `conservative_current_source`. Approved odczyt kapsuł i rzeczywistych
execution copies potwierdził ABI declarations i identyczny SHA FFI
`6c49a9103633e1ad63bd972e7c1d52b7c04948518b752eb0640fa6abd8a71f7a`.
Drugi ma również pole IR i SHA
`80c4a7ac7382686f61687f56ff86530a42c316918b0244d589edae3cf6700473`.
Zachowane execution mtime to odpowiednio 01:07:23Z i 02:08:10Z; stderr
odwołuje się do starszych deklaracji zależności. To nie brak nowych bajtów
w kapsule. Mechanizm mtime freshness opisuje
[dokumentacja Cargo](https://doc.rust-lang.org/stable/nightly-rustc/cargo/core/compiler/fingerprint/index.html);
diagnoza tej konkretnej kolejki wynika z lokalnych źródeł, hashy i regresji.

Wybrano `copyfile` zamiast `copy2` w trusted `materialize_capsule`: świeże
execution mtime, zachowane size/SHA i odtworzone tryby, bez mutacji source
capsule lub cache. Alternatywy: jawne utime po kopiowaniu (dodatkowy przebieg),
osobny target per digest (utrata reuse i większy storage), eksperymentalne
checksum freshness Cargo (zależność od toolchaina). Kasowanie targetu albo
sam retry nie naprawiają źródła problemu. Regresja na dokładnej funkcji
z poprzedniego HEAD odtworzyła RED, na poprawce uzyskano GREEN; pełny lekki
zestaw entrypointu: **15 zaliczonych, 2 skip** dla Windows symlinks.
Nie jest to rzeczywisty managed build ani naukowa kwalifikacja anteny.

Spójny fragment runnera zapisano osobno w commicie
`9ed09a331bcb0df45840952140fe04a2f05fc599` (3 pliki: materializer, regression,
guide). Pozostały szeroki dirty worktree anteny zachowano bez stagingu.
Trusted entrypoint pochodzi z obrazu koordynatora, nie z kapsuły: poprawka
**nie jest jeszcze wdrożona**. Aktywny job `43e61c9ff44a4c8a92850ea0f0d02779`
nie został przerwany. Wysłano użytkownikowi pytanie o kontrolowaną aktualizację
koordynatora po zakończeniu aktywnego buildu. Nowego buildu tej integracji
jeszcze nie zlecono; unikamy świadomego dodawania kopii do wadliwej trasy.
Końcowy odczyt potwierdził zdrowy worker/API, `accepting_jobs=true`, ten sam
aktywny job oraz stary trusted entrypoint z `copy2`, SHA
`5cfafb9b4ab4488050dc8545fa1721d4a57555b9cdd58528ae1cc222ccf8a906`.
To bezpośredni dowód braku wdrożenia poprawki, nie przypuszczenie o wersji
na podstawie nazwy obrazu.

Następne kroki: autoryzowana aktualizacja trusted coordinator, nowy jawny
snapshot ze wszystkimi required untracked inputs i receipt/hash checks;
wykonanie prawdziwego single-bundle stage bez LLG; odrębny v2 inspection
resource z bounded binary payloads i typed UI. Normalizacja, closure/global
field error, LLG/FFT i macierz urządzeń wymagają własnych scientific gates.
T05/T06/T08/T12/T14/T15/T18 pozostają otwarte; cały T00–T18 nie jest ukończony.

**Checkpoint T14 — 2026-10-04: odrębne API inspekcji, tylko źródła.**
Podłączono źródłowo JSON resource
`data/antenna/stages/{stage_id}/external-lead-inspection` oraz odrębny binary
payload GET. URL używa dokładnego runtime stage ID; wynik zachowuje authored
`stage_id` i raw `inspection_ref`, bez asset/basis/quantity promotion.
JSON przenosi `record_content_digest`, `inspection_only|failed|cancelled`,
scope, qualification, jednostki i opcjonalny thin manifest. Nowy wspólny
manifest-only parser sprawdza canonical shape/digest oraz pięć fixed
descriptorów (unit/count/checked size/128 MiB), ale nie czyta tablic ani nie
poświadcza ich integralności. Pole `validation_scope="manifest_only"`
zachowuje tę różnicę. Binary wymaga `inspection_ref.content_digest`, pełnego
istniejącego owned bundle loadera i wybranego SHA/size, zanim obsłuży
`200/206/304/416`. H pozostaje A/m, V w V, RT0 w A wewnątrz bundle.

Session/epoch/run/stage/revision/root/refs pochodzą z jednej migawki;
ponowna kontrola ownera po I/O odmawia zmiany session/run lub refs. Ciężki
odczyt/verifier odbywa się poza async executor przez `spawn_blocking`.
Jeden owner rekordu leży pod jawnym artifact root:
`antenna/external_lead_stage_outputs/<runtime_stage_id>/`.
CLI używa tego samego miejsca dla success/failed/cancelled, również przy
pośrednim etapie i `--output-dir`. API nie poszerza katalogu sesji ani nie
skanuje innych etapów; reference musi wskazywać exact bounded regular file
bez traversal/symlink descendants. Presentation `entrypoint_kind` może
pozostać `study_pipeline_antenna_field_solve` albo authored etykietą: nie
aktywuje fizyki. Checked record definiuje stage kind i resolved action.

Niezależny review wykrył i usunięto źródłowo trzy realne luki: scripted
records miały `stage_id=None`; non-cancel failure nie publikował terminal
stage/ref; `relative_artifact_ref` porównywał zwykły Windows root z canonical
`\\?\D:\...` przed kanonikalizacją. Runtime IDs są teraz stabilne, inspection
failure ma `BackendError` i exact ref, a helper kanonikalizuje root/path przed
containment/strip. Tworzenie manifest ref jest wewnątrz producer-result
failure boundary: błąd po publikacji artefaktu pozostawia go na dysku, ale
zapisuje failed record bez output promotion.

Dodano **11 niewykonanych regresji Rust**: 3 reader/publication, 6 API/router/
OpenAPI i 2 CLI. Rozróżniają metadata od corrupt/missing payloads, rehashed
descriptor errors, terminal records, conditional cache/revision/session,
digest/no-RT0 gate, malformed records, exact registered namespace, bound,
runtime IDs i canonical root alias. Nie są proof kompilacji ani runtime.
Brakuje ponadto pozytywnego HTTP `200/206/304` dla pełnego rzeczywistego
binary artifactu oraz deterministycznej regresji zmiany ownera w trakcie I/O
i symlink descendant na Windows. Te bramki pozostają jawnie otwarte.

Routes/DTO/typed error responses i source OpenAPI zostały podłączone razem.
Nie edytowano generated files ręcznie, nie uruchomiono starego binarium dla
generacji. `generate:api` wymaga nowego binarium; wspólny runner nadal czeka
na autoryzowaną aktualizację sprawdzonego trusted materializer fix.
Generated client, facade/hooks, UI/viewport oraz managed HTTP/native
science proof muszą być domknięte jako jeden T14/T15 przyrost.
Cały moduł T00–T18 pozostaje **aktywny i nieukończony**. Ten zależny przyrost
pozostaje WIP, bez nowego commita i bez rozszerzania dotychczasowego stagingu.

**Dowody lekkie i niezależne przyrosty.** Parser Rust przeszedł dla sześciu
zmienianych modułów nadrzędnych; walidator noty 0950/source-map i scoped
`git diff --check` przeszedł. Nie kompilowano ani nie uruchamiano regresji
Rust/native. Niezależna poprawka rozpoznawania `async fn` w walidatorze jest
w commicie `df7aaa2a6cdd710b37febd31591a0e33aaa92880` (wyłącznie dwa pliki
walidatora). Zachowano RED dla nowych deklaracji i GREEN: 33 lekkie testy
Python. Nie poluzowano odmowy comments/calls/duplicate declarations.
`skill-creator/quick_validate.py` nie wykonał walidacji pakietu z powodu
braku `yaml` w interpreterze; frontmatter ani instrukcji skilla nie zmieniano,
nie instalowano zależności. Nie jest to wynik pozytywny tego narzędzia.

Dodano niezależny, tylko odczytowy checker
`scripts/smoke_antenna_external_lead_inspection.py` i
[instrukcję](../../guides/antenna-external-lead-http-smoke.md). Sprawdzono
14 lekkich regresji Python: pełny przebieg harnessu, descriptor/output
odmowy, SHA/nonfinite, pojedynczy ETag, dokładny Range i data-plane headers,
revision drift oraz rzeczywisty loopback transport bez proxy/redirectów,
z oversize/truncated body. Niezależny review wymusił exact nested output,
limit sample count, właściwe ETag/Range nagłówki i mapowanie HTTPException.
Checker zachowuje `NOT VERIFIED`/`physics_qualified=false` nawet przy pass;
fixture HTTP nie jest valid numerical bundle. Uruchomienie przeciw native
API nadal nie nastąpiło i nie zamyka pozytywnej bramki HTTP ani T14.
Ten niezależny przyrost (checker, 14 lekkich regresji i instrukcja) zapisano
w commicie `c41237ab051f4d288aa487a2440513834b1bbc0e`. Scoped staged diff
przeszedł `git diff --check`; poprawki z review mają regresje. Po dodaniu
dwóch source-map powiązań walidator noty 0950 przeszedł. Nie ponawiano
niezmienionych zielonych testów wyłącznie z powodu commita.

**Checkpoint Git — 2026-10-04, pobranie mastera na zlecenie użytkownika.**
`git fetch origin master` zakończył się exit 0. Nowy `origin/master`:
`e7c04d50bb6a1c62477c52bd12f1eb1174680185`; HEAD brancha przed kolejnym
przyrostem: `df7aaa2a6cdd710b37febd31591a0e33aaa92880`.
`git rev-list --left-right --count HEAD...origin/master`: 159/355.
Merge base: `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`.
Po rozwinięciu untracked plików policzono 164 dirty paths; 47 nakłada się
na 2286 ścieżek zmienionych po stronie mastera od merge base. Nie jest to
liczba konfliktów merge, tylko rzeczywiste nakładanie WIP. Nie wykonano
stash/reset/scalenia. Najpierw trzeba jawnie uzgodnić zabezpieczenie całego
WIP, także untracked, a następnie wykonać integrację i ponownie zweryfikować
zmienione kontrakty. Fetch zgłosił nieinicjalizowany submodule
`external_solvers/3`; aktualizacja master ref jest potwierdzona, kompletność
zewnętrznego checkoutu nie. Nie pobierano zależności ani nie uruchamiano buildu.

**Checkpoint integracji — 2026-10-04, diagnoza bez scalenia.**
Poprzedni przyrost stanowi postęp: pobrano master i zapisano dwa niezależne
fragmenty z lekką weryfikacją. Aktualny HEAD:
`c41237ab051f4d288aa487a2440513834b1bbc0e`; master nadal
`e7c04d50bb6a1c62477c52bd12f1eb1174680185`; rozjazd commitów 160/355.
`git merge-tree --write-tree --name-only --no-messages HEAD origin/master`
zwrócił **exit 1 i 14 konfliktujących plików**. Utworzył wyłącznie
diagnostyczne drzewo obiektów Git
`00002fd85a1089381a36da94f2941a2ba096e258`, nie zmienił brancha, indexu
ani plików worktree. To nie jest gotowy merge ani commit. Analiza dotyczy
wyłącznie zapisanych commitów; nie obejmuje odtworzenia uncommitted WIP
i nie dowodzi, że po nim liczba konfliktów pozostanie taka sama.

| Konfliktujące pliki | Kontrakt wymagający zachowania i sprawdzenia po integracji |
|---|---|
| `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`, `openapi-v2.json` | Wygenerować z faktycznie scalonego ApiDoc po buildzie; zachować nowe raw inspection routes/DTO i kontrakty mastera. Nie wybierać ani ręcznie sklejać całego generated pliku jako dowodu zgodności. |
| `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`, `.test.ts` | Zachować lifecycle authoringu z mastera oraz canonical kompozycję anteny. Object identity/presentation nie może samo aktywować fizyki; sprawdzić undo/redo i round-trip. |
| `apps/control-room/src/modules/field-map/FieldMapModule.tsx`, `.test.tsx` | Zachować zmiany mastera i globalny canonical quantity/field-store contract anten; wymagany browser/WebGL smoke, nie sam TypeScript. |
| `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx` | Połączyć canonical drive/legacy migration i revision-conflict workflow z masterowym `runAuthoringMutationWithHistory` oraz session scope. Nie utracić history/context ani stabilności ACK/drafts/scroll. |
| `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` | Master przechwytuje `capture_current_live_request_context` i używa read/commit `_for_context`. Zachować ten sam kontekst przez cały request, także po połączeniu z boxed variant dispatch brancha; nie wracać do ambient current-session read/commit po await. |
| `crates/fullmag-cli/src/orchestrator.rs` | Zapisany konflikt obejmuje importy testów; dodatkowo odtworzyć WIP runtime IDs, exact inspection artifact root i terminal failed/cancelled refs. Nie utożsamiać authored ID z runtime ID. |
| `native/include/fullmag_fem.h` | Zachować `FULLMAG_FEM_API` i public C ABI obu stron. Diagnostyczne drzewo pokazuje plain `fullmag_fem_solve_charge_transport_v1/v2` oraz konflikt deklaracji `fullmag_fem_solve_steady_transport_m2_v1`; sprawdzić także nowe WIP funkcje, exports i Rust FFI. Nie eksportować prywatnego C++ API ani zmieniać układu ABI w ramach rozwiązania konfliktu. |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py`, `packages/fullmag-py/src/fullmag/world.py` | Zachować canonical authoring mastera, authored port modes brancha oraz `_render_field_drives` z overrides. Wymagane round-trip/stage-order regresje; nie odtwarzać physics modules z nazwy lub typu. |
| `scripts/just_storage_shell.sh` | Połączyć bootstrap/discovery z admission/preflight/recovery mastera. Sprawdzić kolejność inicjalizacji zmiennych i zamkniętą kontrolę argumentów; diagnostic substring nie może omijać allowlisty ani tworzyć nowego storage root. |
| `scripts/local_runner/build_entrypoint.py` | Zachować masterowe release outputs/worker services, nightly preflight i nonempty-output checks, a także świeże mtimes prywatnych źródeł. Master używa już `shutil.copy`, branch `copyfile` z odtwarzaniem deklarowanych modes; oba odejścia od `copy2` wymagają wspólnej regresji, nie równoległego deployu starej wersji pliku. |

W szczególności wcześniejsza diagnoza starego trusted materializera nie
oznacza, że master nadal ma `copy2`. **Master source ma już własną poprawkę**;
stan wdrożonego koordynatora trzeba odczytać osobno. Ten checkpoint nie
potwierdza jego deployu, aktualizacji ani poprawności żadnego joba.

Kolejność po uzyskaniu zgody na zabezpieczenie WIP:

1. Utrwalić nazwany, pełny checkpoint tracked/untracked i zweryfikować jego
   zakres oraz możliwość odtworzenia. Zachować referencję kopii do końca
   integracji; nie wykonywać automatycznego `stash pop/drop` ani resetu.
2. Scalić zapisany branch z dokładnym master SHA, rozwiązać powyższe
   konflikty semantycznie, następnie odtworzyć i ponownie rozwiązać WIP.
   Rozdzielić te dwie fazy i ich diffy. Nie włączać konfliktujących fragmentów
   przez wybór całego `ours/theirs`, zwłaszcza request context/ABI/generated.
3. Odczytać obowiązujące po scaleniu AGENTS/instructions/justfile, wykonać
   adekwatne lekkie/parsers/source-map bramki i ocenić nowe zależności runtime.
   Testy Rust/native pozostają niewykonane przy obowiązującym zakazie ich
   kompilacji; pełny build i generacja API używają tylko zatwierdzonej kolejki.
4. Wykonać wymagane build, HTTP/native, browser/WebGL i science gates dla
   finalnych źródeł oraz ich receipts. Stare lekkie GREEN nie dowodzą nowej
   integracji ani ukończenia modułu. T00–T18 nadal pozostaje otwarte.

Zgody na stash/scalenie ani na zmianę wspólnego koordynatora nie otrzymano
w tej kontynuacji. Automatyczne wznowienie celu nie jest taką zgodą.

**Checkpoint runnera i audyt blokady — 2026-10-04.**
Poprzednia kontynuacja była postępem (diagnoza 14 konfliktów i zapis planu
integracji), nie zakończeniem modułu. W kolejnej kontroli potwierdzono
rzeczywisty żywy worker `17fa9a098db5` przez runnerowy odczyt Docker metrics,
nie tylko wpis `running` w bazie. Następnie jedno bounded `wait` (maks. 30 s)
dla joba `48268507023c413a97f1e9c944769e58` zwróciło **succeeded, exit 0**.
Nie wywnioskowano terminal state z timeoutu ani starego heartbeat; nie
restartowano i nie anulowano próby.

Odczytany `fullmag.local-runner.build-receipt.v1` potwierdza profil
`fem-cpu-release`, 109 pozycji artifacts i trzy etapy z exit 0:
native-build (2570.013 s), frontend-dependencies (1141.464 s) oraz
frontend-build (447.989 s). Receipt zachowuje `qualification=NOT VERIFIED`.
Źródła tego joba to wcześniejszy snapshot publication, nie nowe API:

| Powiązanie źródeł | Wartość z odczytu |
|---|---|
| Built HEAD | `cab4859b1fb3f0243d2844ac41fdee921bacc9d8` |
| Capsule/source digest | `7f7e72a89e59104a9a9a125d1b30becd0fb7f49f0777a0c4d0d680b93131d499` |
| Built native snapshot | `32096252bc20ef4115ad6680488ffdcbc8c0407ab1caa4208d967a18591c5362` |
| Aktualny HEAD | `c41237ab051f4d288aa487a2440513834b1bbc0e` |
| Aktualny native snapshot | `81b1f7d401a417052608e79f512361c7cbc06233b69a61f25de0b9f7ec392f85` |
| Zgodność snapshotów | **false** — osobno obliczono `native_identity(..., "snapshot")` dla bieżącego worktree |

To dowód zakończenia konkretnego wcześniejszego buildu, nie kompilacji
aktualnych handlers/CLI, poprawności J/H, pełnego HTTP, UI/WebGL ani LLG.
Nie uruchomiono jego binarium jako zamiennika nowego API, nie promowano
starego runtime'u i nie omijano source-binding gate. W szczególności sukces
buildu nie dowodzi wdrożenia bieżącego trusted materializera koordynatora.

Blokada integracji powtórzyła się w co najmniej trzech kolejnych turach:
zabezpieczenie całego tracked/untracked WIP i scalenie mastera nadal czeka
na decyzję użytkownika. Fetch, analiza nakładania WIP, diagnostyczny merge,
review kontraktów, lekkie regresje i odczyt wcześniejszej próby zostały
wykonane; dalsze restatementy lub nowe buildy starej bazy nie zastępują
integracji. Worktree, staging (pusty), HEAD i master ref pozostają zachowane;
nie wykonano stash, resetu, cleanupu, deployu koordynatora ani nowego enqueue.
Pełny cel T00–T18 pozostaje nieukończony. Następny krok: decyzja o nazwanym
checkpointcie WIP i scaleniu mastera, potem ponowna kontrola finalnych źródeł
i wymaganych gates. Status celu należy oznaczyć `blocked`, nie `complete`
ani `paused`; nie oznacza to błędu ani zatrzymania zakończonego joba runnera.

**Wznowiony cel: aktualny master i diagnostyka pełnego WIP — 2026-10-04.**
Po wznowieniu celu wykonano nowy audyt bieżącego worktree; wcześniejszy stan
`blocked` nie jest automatycznie przenoszony na wznowioną pracę. Ponowiony
`git fetch --no-recurse-submodules origin master` oraz odczyt zdalnego refu
potwierdziły master `1010f5d94cb13a9aae2e5644992c0fc26c93f33e`. HEAD brancha
pozostał `c41237ab051f4d288aa487a2440513834b1bbc0e`; rozbieżność wynosi
160 commitów wyłącznie na branchu i 406 wyłącznie na masterze.

Próbne scalenie objęło tym razem **cały aktualny WIP**: 124 zmienione tracked
pliki oraz 38 untracked plików. Użyto osobnego `GIT_INDEX_FILE` pod
resolverowym `storage/tmp/<worktree-id>/master-merge-preview-...`.
`read-tree`, indeksowanie dokładnie zinwentaryzowanych ścieżek i `write-tree`
utworzyły drzewo `ce260b1876820ad732d9664f216516db13457c38`.
Obiekt diagnostycznego commita `8c79cdd754a2e9d41197c50a930c55ab235a1780`
nie zmienił żadnego brancha/refu. `merge-tree --write-tree --name-only
--no-messages` zwrócił exit 1 i drzewo
`5940e18bb582e6879bc00bd47c0275683ee8a459`: **19 konfliktujących plików**.
Nie jest to rzeczywisty merge ani checkpoint gwarantowany trwałym refem.

```text
apps/control-room/package.json
apps/control-room/src/kernel/api/generated/openapi-v2-types.ts
apps/control-room/src/kernel/api/generated/openapi-v2.json
apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.test.ts
apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts
apps/control-room/src/modules/field-map/FieldMapModule.test.tsx
apps/control-room/src/modules/field-map/FieldMapModule.tsx
apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx
crates/fullmag-api/src/router_v2/handlers/model/authoring.rs
crates/fullmag-api/src/router_v2/tests.rs
crates/fullmag-cli/src/orchestrator.rs
crates/fullmag-runner/src/fdm/cpu/reference.rs
native/include/fullmag_fem.h
packages/fullmag-py/src/fullmag/runtime/scene_document.py
packages/fullmag-py/src/fullmag/runtime/script_builder.py
packages/fullmag-py/src/fullmag/world.py
packages/fullmag-py/tests/test_current_transport.py
scripts/just_storage_shell.sh
scripts/local_runner/build_entrypoint.py
```

Porównanie HEAD, SHA-256 prawdziwego indeksu oraz pełnego source-snapshot
przed i po diagnostyce potwierdziło brak zmian plików roboczych i indeksu;
staging pozostał pusty. Poniższa późniejsza edycja dokumentu jest wyłącznie
zapisem wyniku tej kontroli, nie zmianą kodu solvera.

Odczytano konflikty pięciu dodatkowych plików względem wcześniejszej analizy
14 konfliktów zapisanej historii. Wnioski do rzeczywistej integracji:

| Plik / kotwica | Rozstrzygnięcie wymagane przed weryfikacją |
|---|---|
| `apps/control-room/package.json`, pole `scripts` | Zachować jednocześnie `smoke:antenna-authoring-ui` i `test:antenna-authoring-browser` brancha oraz `docs:bundle`, `test:bundle-docs`, `check:start-screen-browser` mastera. Zwalidować JSON i istnienie wejść skryptów; nie zastępować całego manifestu jedną stroną. |
| `crates/fullmag-api/src/router_v2/tests.rs`, deklaracje modułów | Zachować `mod antenna_inspection`, `mod project_documents` oraz `mod session_scope` z ich atrybutami `#[path]`. Samo przywrócenie deklaracji nie dowodzi kompilacji ani przejścia testów. |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs`, testy `reference_problem_rejects_short_antenna_mask_before_execution`, `fdm_cpu_accepted_state_snapshot_is_content_bound_and_strictly_scoped`, `simple_fdm_cpu_lane_emits_accepted_state_snapshot_from_final_transactional_state` | Zachować trzy oddzielne testy, każdy z własnym `#[test]` i prawidłowym domknięciem funkcji. Tekstowy konflikt nie jest konfliktem fizyki, ale wybór jednej strony usunąłby ochronę antenowego mask ordering albo accepted-state provenance. Sprawdzić także ich rzeczywistych konsumentów, nie tylko blok testowy. |
| `packages/fullmag-py/src/fullmag/runtime/scene_document.py`, `_decode_current_transport` | Zachować masterowe `_reject_unknown_fields` na wszystkich zagnieżdżonych granicach oraz obsługę `equipotential_current_terminal` brancha. Do masterowej mapy dozwolonych pól tego rodzaju dodać dokładnie `id`, `kind`, `surfaces`; nie dopuszczać sztucznego `potential_V` ani dowolnych przyszłych pól. Następnie zdekodować przez `EquipotentialCurrentTerminal`, bez zmiany normalizacji/gauge. |
| `packages/fullmag-py/tests/test_current_transport.py`, klasa `CurrentTransportTests` | Zachować osobno test round-trip terminali bez dummy voltages i test odrzucania nieznanych pól wewnętrznych mastera. Dodać scenariusz terminala z niedozwolonym polem oraz nieznanym polem w jego `surfaces`, żeby sprawdzić wspólną granicę po scaleniu, a nie tylko dwie rozłączne fixture. |

Pozostałe 14 ścieżek nadal wymaga semantycznego review względem **nowego**
SHA mastera; starsza tabela jest wskazówką zachowania kontraktów, nie
potwierdzeniem poprawności ich obecnego scalenia. Szczególnie chronić
request-scoped session context, publiczne ABI, overrides eksportu Python,
runtime stage IDs, manifest/payload namespaces i regenerację OpenAPI.

W tej wznowionej pracy nie wykonano stashowania, rzeczywistego merge,
resetu, publikacji brancha, enqueue ani zmiany koordynatora. Na pytanie o
nazwany pełny checkpoint WIP i scalenie użytkownik jeszcze nie odpowiedział;
automatyczna kontynuacja celu nie zastępuje tej decyzji. Po decyzji wykonać
integrację w kolejności opisanej powyżej, a potem bramki dla finalnych
źródeł. T00–T18, runtime/API/browser oraz kwalifikacja fizyczna nadal nie są
ukończone; konfliktów nie wolno uznać za rozwiązane na podstawie tej tabeli.

Weryfikacja checkpointu: oba manifesty `package.json` parsują się, a pięć
wymienionych wejść skryptów istnieje po właściwej stronie scalenia. Skupiony
walidator planu/source-map przeszedł po naprawie kotwicy
`validate_time_dependence`: deklaracja jest teraz w
`crates/fullmag-ir/src/field_drive_validation.rs`, a `validation.rs` ją
importuje i wywołuje. Zachowano oryginalne mieszane zakończenia linii mapy;
jej diff obejmuje jedną zmienioną ścieżkę. Kontrola whitespace z jawnym
`cr-at-eol` przeszła. Są to dowody dokumentacji/źródeł, nie wykonania anteny.

**Autoryzowana integracja mastera i odtworzenie WIP — 2026-10-04.**
Użytkownik odpowiedział „tak” na pytanie o nazwany stash całego WIP,
scalenie mastera i rozwiązanie konfliktów. Wcześniejsze wpisy o braku zgody
są historyczne; ta blokada została usunięta. Cel T00–T18 pozostaje aktywny.

| Referencja / kontrola | Wynik |
|---|---|
| Master pierwszej fazy | `688f1f23c96d21fd965be951e349d1daca25f182` |
| HEAD przed scaleniem | `c41237ab051f4d288aa487a2440513834b1bbc0e` |
| Commit rzeczywistego merge | `5d1c769f76701cb4da07a18bb2b7b46c8527dd92`; oba powyższe SHA są jego rodzicami |
| Trwała kopia WIP | stash `antenna-pre-master-sync-20261004-a5bf3f42`, commit `11eb4bcff86d48b267362a5b0f07764dc3f1620a` |
| Zakres kopii | 125 tracked i 38 untracked; zweryfikowany przed scaleniem |
| Odtworzenie | `stash apply` wskazanego pełnego SHA, bez `pop/drop`; stash nadal zachowany |
| Zachowanie untracked | 38/38 blobów zgodnych ze stashowym drzewem; zero brakujących/dodatkowych ścieżek |
| Zachowanie tracked | po odtworzeniu zbiór 125 ścieżek WIP zgodny z kopią; konflikty zmieniają treść wyłącznie przez integrację obu kontraktów |
| Kolejny pobrany i scalony master | `978ac48eaee025a04db95265aace397babe20fcf` |
| Końcowy commit merge / HEAD | `f69f14be1cd343647e9fedfebac9d936e988353c`; rodzice: pierwszy merge oraz kolejny master |
| Kopia zintegrowanego WIP | stash `antenna-integrated-wip-before-master-978ac48-20261004`, commit `cf45d1142a8a5778efd0b1a012654067f6189ad5`; pierwotna kopia także zachowana |

Podczas kontroli master przesunął się ponownie. Pobrano dodatkowe 100
zmienionych ścieżek; jedyną wspólną ścieżką z WIP był `apiPaths.ts`.
Po zweryfikowanym zabezpieczeniu zintegrowanego WIP wykonano drugi merge
i ponowne `stash apply`: oba bez konfliktów. Końcowe `HEAD...origin/master`
ma **0 commitów wyłącznie po stronie pobranego mastera**. Lokalny WIP
pozostaje odtworzony i niestage'owany, a indeks nie zawiera konfliktów.

Rozdzielono dwie fazy: **15 konfliktów zapisanej historii**, następnie
**7 konfliktów odtwarzanego WIP**. Nie zastąpiono całych plików przez
`ours/theirs`. Zachowano masterowe request-context/session fences i historię
authoringu razem z antenowym boxed dispatch; utrzymano warianty Python
`study.parameter`, overrides oraz rejestrację portów/solve. Deklaracje testów
API `antenna_inspection`, `project_documents`, `session_scope` i trzy osobne
regresje FDM accepted-state/krótkiej maski zostały zachowane. Parser Rust
trzech konfliktujących plików przeszedł; ich testów nie kompilowano.

W nagłówku FEM zachowano pełne sygnatury obu stron i oznaczono wszystkie
95 publicznych funkcji przez `FULLMAG_FEM_API`, także nowe charge v3,
accepted-terminal/external-lead, charge-snapshot oraz automatycznie scalone
`fullmag_fem_backend_begin_stage_v2`. Kontrola źródłowa potwierdza zgodność
11 nowych typedefów WIP ze stashem, nie eksporty rzeczywistej biblioteki DLL.

Python zachowuje ścisłe odrzucanie nieznanych pól; terminal
`equipotential_current_terminal` akceptuje dokładnie `id/kind/surfaces`.
Osiem dodatkowych przypadków sprawdza niedozwolone pola terminala i jego
surface. Wykryty RED round-trip `conservative_current_source` naprawiono
przez dodanie tego jednego istniejącego klucza do masterowej allowlisty;
pozostałe walidacje nie zostały poluzowane. Po poprawce przeszły **73/73**
lekkie testy Python i **22/22** funkcje workflow antenowego. Zmienione pliki
frontendu przeszły parser i scoped ESLint; mock Inspectora uwzględnia
masterowe session-scope request options. Browser/WebGL nie został wykonany.

OpenAPI historii po pierwszej fazie zregenerowano kanonicznie przez
`just generate-api-openapi` i `just generate-control-room-client`, bez
ręcznej edycji JSON/types. Receipt pierwszej generacji API:
`windows-api-source-check/api-openapi-codegen/2cd8e7bf1a9f44c68d2866dc1c495f58/receipt.json`;
klienta: `windows-control-room-source-check/generate-client/4401c421d03c4b4ab4f65bf7a419511f/receipt.json`.
Prefiks wszystkich poniższych ścieżek receipt to resolverowe
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`.
Pierwsza para ma wynik `passed`, ale dotyczy źródeł **przed odtworzeniem WIP**.

Druga kanoniczna generacja OpenAPI, obejmująca odtworzony WIP przy HEAD
pierwszego merge, zakończyła się **passed, exit 0**; source digest przed/po
jest zgodny. Receipt:
`windows-api-source-check/api-openapi-codegen/39697c53d2124ed2836b08e084fbe678/receipt.json`.
Jest to kompilacja produkcyjnego generatora API, bez kompilacji testów i
bez FEM. Kolejna aktualizacja mastera nie zmieniła `openapi_v2.rs`, schemas
ani produkcyjnych ciał handlers: zmiany API obejmują dev-dependency i testową
fixture. Zachowano kanonicznie wygenerowany JSON, nie ręczną rekonstrukcję.

Po drugim merge i ponownym odtworzeniu WIP wykonano:

| Końcowa bramka źródeł przy HEAD `f69f14be1cd343647e9fedfebac9d936e988353c` | Wynik / receipt |
|---|---|
| `just generate-control-room-client` | **passed**, `windows-control-room-source-check/generate-client/0ce87e8254b848008027766b5d9be169/receipt.json` |
| `just check-control-room-production-source` | **passed**, `windows-control-room-source-check/production-source/4ffb1444ba4f4822a0b52caebac784ea/receipt.json`; source digest przed/po zgodny |
| `just check-control-room-api-hygiene` | **passed**, `windows-control-room-source-check/api-hygiene/ce3fab45a5be40e48f481ace9a1ed714/receipt.json` |
| Walidator planu/source-map i kontraktów dokumentacji | focused validator **passed**, **33/33** lekkie testy dokumentacji |

Kanoniczny JSON obejmuje 970 schemas i 278 paths, w tym oba endpointy
external-lead inspection i masterowy runtime-service. TypeScript source
check wyklucza test/spec bundles; nie jest wynikiem ich uruchomienia.
Powyższy generator nie dowodzi pełnego buildu końcowego workspace ani
kwalifikacji natywnego workflow anteny.

Nie wykonano push/PR, deployu wspólnego koordynatora, usuwania kopii ani
worktree. Synchronizacja Git nie zamyka T05/T06/T13–T18: nadal wymagane są
kontenerowy build finalnego FEM, wykonanie HTTP/native, browser/WebGL,
konwergencja J/H, LLG i osobne dowody CPU/GPU. Stare receipts innych
snapshotów nie mogą zastępować tych bramek. Kolejna kontrola T14 powinna
objąć także masterowy `request_scope_epoch` w odrębnych zasobach antenowych,
nie tylko zgodność session/run/stage i digestów artefaktów.

- [ ] Przeprowadzić nowy terminal solve T05 przez istniejące RT0. Sprawdzić osobno: divergence na elementach, skoki normalnego strumienia na ścianach wewnętrznych, bilans elektrod i zgodność closure interfaces.
- [ ] Użyć istniejącej adaptive tetra/Duffy realizacji. Nie zastępować jej centroidami ani smoothingiem H przy źródle.
- [ ] Przygotować analityczne/niezależne źródła: długi skończony przewodnik, zamknięta pętla, symetryczny CPW; odległości targetów muszą obejmować near-field, obszar próbki i far-field.
- [ ] Rozdzielić błąd solve J od błędu całkowania H: przy ustalonym prądzie RT0 zacieśniać kwadraturę; przy ustalonych punktach i zaostrzonej kwadraturze zagęszczać siatkę.
- [ ] Użyć co najmniej trzech poziomów siatki dla taperu T04. Mierzyć terminal currents, normy J poza ostrymi narożami oraz L2/Linf H na tych samych punktach fizycznych. Nie wymagać zbieżności punktowego J w idealnej osobliwości.
- [ ] Wyegzekwować failure przy przekroczonym błędzie kwadratury. `unconverged_pair_count > 0` nie może przechodzić jako zwykłe ready.
- [ ] Zmierzyć liniowość: pole dla 2 A ma być dwukrotne, odwrócenie prądu ma odwracać wektor, zmiana gauge nie może zmienić J/H. Zapisać surowe wektory, a nie tylko obraz.

Tabela danych obowiązkowego fixture testu znaku:

```text
case                 I_ref_A    expected_relation
positive              1.0      H_positive
double                2.0      2 * H_positive
negative             -1.0     -H_positive
shifted_gauge         1.0      H_positive
```

**Bramka:** `just verify-antenna-contracts native-field`. Raport zawiera wszystkie poziomy, błędy i wersje operatorów; brak dopasowanego testu CPU/GPU nie jest parity proof.

## T07. Ujednolicić waveform i aktywację, odciąć RF od Relax

**Pliki:** nowe `crates/fullmag-ir/src/field_drive_validation.rs`, istniejące IR validation/antenna/lib, planner util/fem, runner antenna_fields/native_fem i FDM reference.

- [x] Przenieść obecną funkcję `validate_time_dependence` do wspólnego wewnętrznego właściciela, zachowując wszystkie reguły. Wywoływać ją dla regional i solved drive w obu wersjach IR.
- [x] Wspólna walidacja activation sprawdza puste, powtórzone i nieistniejące stage IDs. Powiązanie z kolejnością pipeline sprawdzać tam, gdzie znana jest cała lista stage; nie udawać kompletności lokalnej walidacji singular StudyIR.
- [x] W plannerze dodać **nową** funkcję `drive_activation_is_active(activation: &DriveActivationIR, problem: &ProblemIR) -> bool`, używaną przez oba rodzaje drive. `AllTimeEvolution` oznacza wyłącznie `StudyIR::TimeEvolution`.
- [x] Materializować i wczytywać artefakty tylko dla aktywnych drives. Dzięki temu Relax nie wymaga przyszłej bazy anteny, której jeszcze nie wykonano.
- [x] Native packing otrzymuje już rozstrzygnięte aktywne termy; usunąć duplikaty „AllTimeEvolution => true”. Nie próbować odtwarzać rodzaju study z parametrów timesteppingu.
- [x] Jawnie wybrany Relax z dynamicznym waveform odrzucić według istniejących reguł minimizera. Stałe pole w Relax wymaga jawnej aktywacji; nie wynika z domyślnego RF drive.
- [ ] Dodać regresje `solve → relax → run`, `relax → solve → run`, stage-local time restart i nieaktywnego drive z brakującym przyszłym assetem.

Stan checklisty oznacza obecność kontraktu w kodzie, nie kwalifikację runtime.
Źródła: `fullmag-ir/src/field_drive_validation.rs` jest wspólnym walidatorem;
`fullmag-ir/src/validation.rs` i `antenna.rs` stosują go do obu typów napędu
oraz odrzucają dynamiczny napęd aktywny w Relax. `fullmag-plan/src/util.rs`
wyznacza aktywację według `StudyKindIR` i `active_stage_id`; plany FEM/FDM
filtrują napędy regionalne, a CLI w `attach_solved_antenna_drive_bases`
pomija nieaktywny solved drive przed dostępem do assetu. Native FEM pakuje
wyłącznie rozstrzygnięty plan i odrzuca nieaktywną bazę, gdyby do niego trafiła.
Brakuje wykonanej regresji obu kolejności pipeline oraz restartu zegara;
obowiązujący zakaz testów jednostkowych uniemożliwia teraz zamknięcie T07.
Dodano źródłową regresję granicy referencji dla obu kolejności
`solve → relax → run` i `relax → solve → run`: nieaktywny Relax nie rozwiązuje
referencji nawet po publikacji, a Run odrzuca brak wcześniejszej publikacji i
przyjmuje pasujący port po niej. Test nie został uruchomiony; nie dowodzi
jeszcze wykonania pełnej sekwencji etapów ani restartu zegara w solverze.

**Otwarty błąd kontraktu czasu (audyt 2026-10-02):** Python helper
`packages/fullmag-py/src/fullmag/runtime/helper.py` wylicza
`stage_start_time_s` z sumy *zadeklarowanych* `default_until_seconds`, zanim
pozna faktyczny koniec Relax. Planner przenosi tę wartość do `time_stage`.
To jest jedynie wstępna wartość `export-run-config`: po zakończeniu etapu
`crates/fullmag-cli/src/orchestrator.rs` (`run_script_mode`) zastępuje
ją rzeczywistym `time_offset` przed planowaniem następnego etapu. Nie należy
przypisywać helperowi wiedzy o wyniku Relax przed jego wykonaniem.
FDM CPU inicjalizuje `state.time_seconds` na tej absolutnej wartości, a native
FEM inicjalizuje nią `ctx.state.current_time`; obie ścieżki emitują statystyki
na zegarze absolutnym. CLI `offset_step_update`/`offset_step_stats` dodaje
jeszcze skumulowany `time_offset`, ponieważ zakłada czas lokalny w każdym
backendzie. Zatem po etapie o czasie końcowym `T` następny etap o
`stage_start_time_s=T` może zostać pokazany jako `2T`, a po wcześniejszym
zakończeniu Relax absolutna faza napędu może używać planowanego zamiast
rzeczywistego początku. Rozwiązanie musi rozdzielić: (1) rzeczywisty czas
fizyczny na wejściu następnego etapu, (2) lokalny zegar waveform `t-t_start`,
(3) zegar emitowany przez backend, (4) skumulowany zegar prezentacji.
Zaktualizować start następnego planu na granicy etapów z rzeczywistego
wyniku i offsetować statystyki tylko wtedy, gdy backend emituje czas lokalny.
Nie wyznaczać konwencji z `initial_step_update`: funkcja w
`fullmag-cli/src/step_utils.rs` bezwarunkowo wpisuje `time=0`, także dla
planu z niezerowym `start_time_s`. Konwencja zegara musi być jawna w wyniku
runnera lub w typowanym kontrakcie planu; FEM referencyjny emituje czas
lokalny, natomiast FDM CPU i native FEM używają absolutnego zegara stanu.
Regresja `test_cli_uses_actual_relaxation_end_as_next_stage_start` potwierdza
osobno, że bezpośredni Python CLI przekazuje do drugiego etapu rzeczywisty
koniec Relax i nie podwaja jego czasu w agregacji (`0,4 ps` zamiast limitu
`1 ps`); dwa testy tego pliku przeszły. Nie obejmuje to ścieżki Python helper
→ Rust CLI ani backendów natywnych. Audyt wykazał ponadto, że FDM multilayer
inicjalizuje stan lokalnie od zera, podczas gdy FDM single-grid CPU ustawia
`plan.time_stage.start_time_s`; rozstrzygnięcie czasu na podstawie samego
`BackendPlanIR::Fdm` byłoby zatem niepoprawne. Dodano typowany kontrakt
konwencji czasu dla live callbacków i agregacji `StepStats`; zgodność
snapshotów i pełna kwalifikacja runtime pozostają do sprawdzenia.
**Korekta źródłowa sekwencji skryptowej 2026-10-02:** runner udostępnia
`StageStepTimeFrame`, wyprowadzony z rozstrzygniętego engine i tej samej
ścieżki dispatch co wykonanie: single-grid FDM CPU i native FEM raportują
czas absolutny, FDM CUDA, multilayer FDM i FEM reference — lokalny. Główna
pętla skryptowa Rust CLI nadpisuje oszacowany
`stage_start_time_s` rzeczywistym końcem poprzedniego etapu przed replanningiem;
callbacki i zagregowane `StepStats` przesuwa tylko dla zegara lokalnego.
Native FEM adaptive-remesh follow-up replanuje teraz następny pass od
rzeczywistego końca poprzedniego, bez drugiego dodawania tego czasu do
absolutnych `StepStats`. Produkcyjne diagnostyczne
`cargo check --locked -p fullmag-cli` przeszło; testy Rust pozostają
zabronione. Nowe etapy interaktywne używają rzeczywistego czasu startu i
rozstrzygniętej konwencji runnera, a pause odejmuje tylko czas wykonanego
segmentu. Resume z aktywnym dynamicznym napędem jest jawnie odrzucane,
ponieważ obecny checkpoint nie przywraca oryginalnego początku waveformu;
spięto także ładowanie solved basis w interaktywnej ścieżce. Natywna bramka
multi-stage/adaptive oraz exact RF resume pozostają otwarte —
T07 i T13 nadal otwarte.
**Kontrakt do domknięcia exact RF resume (audyt 2026-10-03):** obecne
`TimeStageContextIR.start_time_s` jest jednocześnie początkiem segmentu
integratora i zerem przebiegu `stage_local`. Po pauzie te chwile są różne:
niech $T_0$ oznacza absolutny początek autorskiego etapu, $T_r$ czas
wznowienia, a $t\ge T_r$ czas ewaluacji RHS. Wymuszenie `stage_local` musi
zachować argument $t-T_0$ (nie $t-T_r$); wymuszenie `absolute` zachowuje $t$.
Kolejny segment integracji startuje w $T_r$, a jego koniec wynosi
$T_r+\Delta t_{remaining}$. Samo przesunięcie zegara wyświetlania lub
`StepStats` nie naprawia fazy.

Wprowadzić w typowanym kontekście planu **oddzielny** niezmienny
`waveform_origin_time_s` z domyślną wartością `start_time_s` dla starych
planów; przy resume przekazywać oryginalne $T_0$ razem z nowym
`start_time_s=T_r`. Walidować oba czasy (skończone, nieujemne,
`waveform_origin_time_s <= start_time_s`) i zachować je w proweniencji
segmentu. Nie używać pola nazwanego „stage start” raz jako $T_0$, a raz
jako $T_r$; nazwy i znaczenie w FFI muszą być jednoznaczne. Rozdzielenie
musi objąć wszystkie konsumenty, nie tylko `antenna_fields.rs`:

1. Planner i `ProblemIR`/CLI: checkpoint zachowuje autorski stage ID,
   $T_0$, $T_r$, elapsed i pozostały horyzont; replan po resume nie może
   zamienić go w nowy etap aktywacji. Rewizja/zgodność checkpointu
   weryfikuje waveform i projekcję rozwiązanej bazy.
2. FDM CPU i FEM reference: stan integratora zaczyna się w $T_r$;
   przeliczenie regionalnego, solved i legacy pola `stage_local` używa
   $T_0$. Harmonogram nieciągłości wyznacza $T_0+t_{knot}$, odrzuca
   zdarzenia sprzed $T_r$, ale nie przesuwa przyszłych knotów.
3. FDM CUDA: solver raportuje czas lokalny segmentu $\tau=t-T_r$;
   device evaluator musi liczyć `stage_local` z
   $\tau+(T_r-T_0)$, a `absolute` z $\tau+T_r$. Deskryptor i kernel
   wymagają dwóch offsetów; upload statycznej bazy pozostaje poza RHS.
   Obecny deskryptor `fullmag_fdm_regional_field_drive_desc_v1` ma jedno
   pole `stage_start_time_s` i jest tablicą indeksowaną rozmiarem struktury
   w `context_upload_regional_field_drives`. Nie dopisywać pola do v1:
   zmiana stride złamie starego klienta binarnego. Wprowadzić osobny
   deskryptor i symbol v2, zachowując adapter v1 z $T_0=T_r$, oraz
   test layoutu/ABI obu wersji.
   Źródłowy krok 2026-10-03: osobne C/Rust ABI v2 i symbol uploadu
   dodano bez zmiany rozmiaru v1; adapter v1 ustawia origin na początek
   segmentu. Deskryptor v2, evaluator CUDA, harmonogram nieciągłości i
   obserwacje Rust używają obu chwil. Dodano test layoutu i regresje
   pakowania/czasu jako kod źródłowy, lecz testów nie uruchomiono zgodnie
   z zakazem w worktree. `Resume` dynamicznego RF pozostaje zablokowane
   do kwalifikacji natywnego urządzenia i checkpointu.
   Lekki `cargo check --locked -p fullmag-fdm-sys --no-default-features`
   przeszedł. Diagnostyczny hostowy check z cechą CUDA nie dotarł do ABI:
   CMake/MSBuild zakończył się `FileTracker FTK1011` przy tworzeniu logu
   w zagnieżdżonym `OUT_DIR/native-build`. Zarządzany
   `runner-container-status` zgłasza brak konfiguracji kontenera; nie ma
   dowodu kompilacji natywnej ani wykonania na urządzeniu. Nagłówek nie
   przeszedł również bezpośredniego `cl /Zs`, bo hostowe środowisko MSVC
   nie miało ścieżek do `stdint.h`; to diagnostyka narzędzia, nie błąd ABI.
4. Native FEM CPU/GPU: dodany kontrakt FFI `begin_stage_v2` zachowuje
   absolutny stan w $T_r$ i ustawia `zeeman.stage_start_time_s` na $T_0$;
   stare `begin_stage` deleguje z $T_0=T_r$. Zegar ten zasila również SOT.
   Runner wyłącza eager initial field przy rozdzielonych zegarach; snapshot
   po `begin_stage_v2` odświeża pole z prawidłowym $T_0$. Interaktywny FEM
   GPU również odświeża snapshot przed zapisem początkowych pól, gdy zegary
   są rozdzielone. Pozostają testy tego porządku, ABI/layout i kontenerowy
   `just` przed odblokowaniem lane.
   Interaktywne lane'y przekazują teraz ten sam origin do harmonogramu
   zdarzeń przebiegu. Harmonogramy uwzględniają również zdarzenia z
   `solved_antenna_drive_bases`; test źródłowy dla impulsu po wznowieniu
   dodano, ale nie uruchomiono. Wymaga to nadal porównania ciągłego i
   przerwanego runu. Relaksacja FEM włącza te zdarzenia również do
   unieważniania cache integratora, jeśli drive jest jawnie aktywny.
   Artefakt regionalnego drive zapisuje teraz oba czasy $T_r,T_0$ i
   poprawne absolutne zdarzenia/FSAL po wznowieniu; test źródłowy nie
   został uruchomiony.
5. Wyniki i UI: agregacja callbacków stosuje `StageStepTimeFrame` tylko
   do prezentacji; output cadence może być lokalny dla segmentu, lecz
   fizyczne sample times i metadata muszą wskazywać ten sam $t$.
   Pauza/wznowienie nie może powielić próbki na granicy ani pominąć
   zdarzenia waveformu tuż po niej.

Test odbiorczy: porównać ciągły i przerwany przebieg tej samej trajektorii
przy pauzie między próbkami dla `stage_local` i `absolute` sinusów oraz
piecewise/pulse (w tym knot po pauzie), najpierw FDM CPU jako oracle,
następnie każdą natywną lane osobno. Sprawdzić pole w punktach RHS, końcową
magnetyzację, czasy i liczbę próbek, a także ponowne wczytanie checkpointu.
Wznowienie dynamicznego napędu pozostaje jawnie zablokowane, dopóki te
kontrakty i testy nie przejdą; statyczna baza policzona raz nie wymaga
ponownego solve przy resume.
Pierwszy fragment źródłowy 2026-10-03: `TimeStageContextIR` przenosi
opcjonalny początek przebiegu odrębny od startu segmentu, a walidacja
`ProblemIR` sprawdza jego zakres. Referencyjny solved-drive evaluator,
FDM CPU regional/solved terms i harmonogram zdarzeń używają tego początku;
stare plany zachowują dotychczasową semantykę. Regresje harmonogramu
i offsetu FDM CPU zapisano, lecz nie uruchomiono z powodu zakazu buildów
testowych. Diagnostyczny `cargo check --locked -p fullmag-runner -p
fullmag-plan`, walidator notatki 0950 i 32 testy walidatora przeszły.
Native FEM/CUDA, checkpoint i odblokowanie Resume pozostają otwarte.
Próba uruchomienia natywnej ścieżki FEM lub FDM CUDA z różnym początkiem
segmentu i przebiegu kończy się obecnie jawnym błędem przed alokacją
backendu; nie jest to emulacja wznowienia ani automatyczny fallback CPU.
Uzupełnienie 2026-10-03: pauza zachowuje pierwotny początek przebiegu i
ponowne planowanie przekazuje go do `runtime_metadata`, zamiast wyznaczać
fazę z nowego początku segmentu. Zwykłe nowe polecenie usuwa odziedziczony
origin. Blokada native FEM/CUDA dotyczy rozdzielonych zegarów tylko gdy
plan zawiera dynamiczne źródło; stałe pole nie powinno tracić istniejącej
możliwości wznowienia. Dynamiczne `Resume` CLI nadal jest zablokowane:
checkpoint nie przenosi jeszcze pełnego stanu integratora i brakuje
kwalifikacji natywnych evaluatorów.
Regresja ma uruchomić co najmniej dwa etapy z `T>0`, Relax kończący się
przed limitem, `stage_local` sinus i `absolute` sinus, porównując fazę pola,
czas wyniku i czas w UI dla FDM CPU, FEM CPU i dostępnych GPU. Sama obecna
regresja referencji symbolicznej nie spełnia tej bramki.

Uzupełnienie 2026-10-02 (jedna semantyka aktywacji): walidacja regional drive
podczas Relax wywołuje teraz `DriveActivationIR::is_active_for`, tak samo jak
solved drive, planner i runner, zamiast powtarzać lokalny `match` dla
`AllTimeEvolution`/`StageIds`. Regresja źródłowa rozróżnia domyślny RF
nieaktywny w Relax od jawnie aktywowanego etapu Relax. Nie uruchomiono jej
z powodu zakazu testów jednostkowych; diagnostyczne
`cargo check --locked -p fullmag-ir` przeszło. Sekwencje wieloetapowe i pełna
kwalifikacja T07 pozostają otwarte.
CLI przed wczytaniem solved basis porównuje też `study_kind` i `active_stage_id`
w `ProblemIR` oraz w rozstrzygniętym planie FEM/FDM. Rozbieżność kończy się
błędem zamiast cichego pominięcia pola lub wczytania assetu dla niewłaściwego
etapu. Istniejąca regresja nieaktywnego przyszłego napędu w Relax zachowuje
brak odczytu assetu; dodano przypadek planu z obcym study kind. Test pozostaje
nieuruchomiony przez zakaz w worktree. Diagnostyczne
`cargo check --locked -p fullmag-cli` zakończyło się kodem 0; nie jest to
kwalifikacja natywnego runtime ani test sekwencji etapów.

Sedno wspólnej reguły:

```rust
match activation {
    DriveActivationIR::AllTimeEvolution {} => {
        matches!(problem.study, fullmag_ir::StudyIR::TimeEvolution { .. })
    }
    DriveActivationIR::StageIds { stage_ids } => active_stage_id(problem)
        .is_some_and(|active| stage_ids.iter().any(|stage| stage == active)),
}
```

Fragment jest ciałem projektowanej funkcji w plannerze, gdzie istnieje `active_stage_id`; nie wolno wkleić go do native Context. Test JSON: sinusoidal `frequency_hz=-1`, pusty `stage_ids`, literówka etapu i powtórzony etap muszą zostać odrzucone. **Bramki:** `model`, `fem-llg`. Commit: `fix: scope solved antenna drives to active study stages`.

## T08. Rozdzielić integralność, aktualność i rozwiązanie referencji

Uzupełnienie 2026-10-02: weryfikator podpisów odrzuca teraz niezgodną
obecność szczegółowych podpisów `terminal/solver/sampling` po obu stronach,
nawet gdy zbiorcze hashe current/field są identyczne. Wcześniej porównywał
te kategorie tylko dla pary `Some/Some`, więc kompletny obecny oczekiwany
kontrakt mógł zaakceptować manifest bez tego bloku. Regresja źródłowa obejmuje
obie asymetrie przy nienaruszonym digestcie manifestu. Diagnostyczne
`cargo check --locked -p fullmag-runner` przeszło; testu jednostkowego nie
uruchomiono z powodu zakazu w worktree. Pozostała macierz invalidation i
kwalifikacja loadera pozostają otwarte.
Loader odrzuca również częściowy zestaw oczekiwanych rewizji źródła:
`geometry_revision`, `material_revision` i `mesh_digest` muszą wystąpić
łącznie albo wszystkie być nieobecne. Dotychczasowe `zip` wyłączało całą
kontrolę rewizji przy braku jednego pola. Dodano regresję źródłową i ponownie
sprawdzono diagnostyczną kompilację kodu produkcyjnego; test pozostaje
nieuruchomiony.

**Pliki:** `antenna_stage.rs`, `antenna_field_solution.rs`, `antenna_field_solve.rs`, nowe CLI `antenna_workflow.rs`; testy w modułach i grupie artifact.

**Wejście:** symbolic stage/output z T03 i aktualny model. **Wyjście:** zweryfikowany resolved asset z oczekiwanym podpisem zależności.

- [ ] Wyznaczać current signature wyłącznie z geometrii/przewodnika, materiałów, terminal constraints, mesh, gauge i operator version. Nie dodawać czasu LLG, m0 ani waveform do tego podpisu.
- [ ] Field signature obejmuje current signature, RT0/closure, realizację i tolerancje kwadratury oraz sampling coordinates/frame. Projection signature dodatkowo obejmuje rzeczywistą topologię/kolejność i scope targetu oraz metodę projekcji.
- [ ] Dodać **nowy** resolved wrapper `ExpectedAntennaSolution` z polami: `reference: AntennaFieldSolutionRefIR`, `current_solution_signature: String`, `field_solution_signature: String`. Resolver liczy oczekiwania bez wykonywania solve.
- [ ] Loader porównuje oczekiwane podpisy ze stored manifest **przed** materializacją do backendu. Digest zawartości sprawdza osobno. Błąd aktualności wymienia kategorię zmiany: geometry, material, terminal, solver, sampling lub target.
- [ ] Nie kasować starego immutable artefaktu, gdy jest stale względem bieżącej sceny. Nadal może być potrzebny do reprodukcji wcześniejszego runu. Aktualny run nie może użyć go niejawnie.
- [ ] Rozwiązać symbolic stage/output dopiero po sukcesie wcześniejszego stage. Odrzucić forward reference, cykl, failed/cancelled output i niezgodny port. Pipeline rozwiązuje wynik każdego portu pod oddzielnym ID.
- [ ] Przy remesh zachować current/field asset, jeśli jego fizyczne zależności się nie zmieniły, a unieważnić tylko projection. Dopóki nie ma nowej projekcji, LLG pozostaje zablokowane.
- [ ] Testować macierz invalidation poniżej z niezmienionym digestem starego pliku. Uszkodzenie bajtów ma dawać inną kategorię błędu niż stale.

```text
mutation                     current     field       projection
waveform or peak_current     reuse       reuse       reuse
equilibrium m0               reuse       reuse       reuse; invalidate transverse analysis
conductor geometry           stale       stale       stale
terminal current weights     stale       stale       stale
conductivity distribution    stale       stale       stale
quadrature policy            reuse       stale       stale
field sampling coordinates   reuse       stale       stale
LLG target remesh            reuse       reuse       stale
target selection             reuse       reuse       stale
```

**Bramka:** `just verify-antenna-contracts artifact`. Commit: `fix: validate antenna dependency signatures before LLG`.

## T09. Naprawić maski i wdrożyć uczciwe próbkowanie/projekcję

Uzupełnienie 2026-10-02 (granica nośnika tet4): sampler widma uznaje teraz
punkt poza **sumą** poprawnych tetraedrów za `outside_domain`, nawet gdy
leży wewnątrz wspólnego AABB ich węzłów. `outside_policy=zero` może wtedy
zapisać zero z licznikiem, a `error` odrzuca punkt. Degeneracja tet4 jest
odrzucana podczas budowy indeksu, przed klasyfikacją outside; ścieżka
kompatybilności point-only nadal odróżnia brak próbki wewnątrz bounds od
punktu poza bounds. Dodano regresje źródłowe obu przypadków. Walidator noty
naukowej (32 testy kontraktu dokumentacji), diagnostyczne `cargo check`
i `git diff --check` przeszły; testy Rust pozostają nieuruchomione na mocy
zakazu w worktree. Nie zamyka to pełnego rozróżnienia stanów ani transferu MFEM.
Publiczny sampler P1 odrzuca też niefinitywną ważoną wartość już podczas
interpolacji (z numerem punktu płaszczyzny), zamiast zwracać ją do transformaty.
Regresja źródłowa używa skończonych wartości węzłowych i punktu dopuszczonego
tolerancją przy ścianie tet4, dla którego arytmetyka `f64` przepełnia wynik.
Diagnostyczne `cargo check`, walidator noty i `git diff --check` przeszły;
regresji Rust nie uruchomiono.

**Pliki:** planner `antenna_projection.rs`, runner `antenna_field_solution.rs`, native nowe `transfer/antenna_field_projection.*`, istniejący direct tetra operator, ABI i sys wrappers.

- [x] Najpierw lokalnie naprawić kolejność: utworzyć wektor zerowy pełnej długości targetu; dla `mask[i]==false` pominąć lookup. Dla aktywnego węzła brak próbki nadal zwraca błąd.
- [x] Test RED/GREEN: source posiada próbkę tylko w `[0,0,0]`; target posiada `[0,0,0]` i `[1,0,0]`; maska `[true,false]` daje pierwsze pole i zero. `[true,true]` nadal odrzuca brak danych.
- [ ] Zdefiniować trzy odrębne realizacje: `identity_coordinates_v1`, `fem_p1_interpolation_v1`, `direct_rt0_evaluation_v1`. Nie nazywać lookupu `fem_element`.
- [x] W nowej wersji field carrier zachować topology/element ordering i sampling scope potrzebne do point location. Same pozycje i H nie wystarczają do klasyfikacji wnętrza.
- [ ] Dla osobnej realizacji `direct_rt0_evaluation_v1` zachować w artefakcie RT0, mesh przewodnika i closure do ponownej ewaluacji.
- [x] Dla P1 użyć barycentrycznych współrzędnych poprawnego elementu; boundary tolerance skalować geometrią. Zdefiniować deterministic ownership dla punktów na współdzielonej ścianie. Nie używać nearest node jako interpolacji FEM.
- [ ] Zwracać rozróżnione stany `inside`, `outside_domain`, `missing_payload`, `unsupported_topology`. Tylko `outside_domain` może być objęte outside-zero. Uszkodzone dane nie mogą dać zera.
- [ ] Obliczenia numeryczne umieścić w native MFEM transfer, runner przekazuje request i zapisuje wynik. Nie powielać solwera interpolacji w React, API i Rust.
- [ ] Sprawdzić constant i affine vector fields, obroty, mikrometrowe/nanometrowe skale, interface nodes, maski regions, remesh i target FDM cell centers. Zachować błąd projection jako element proweniencji.

Projekt algorytmu pierwszej naprawy, bez zmiany interpolatora:

```text
allocate target_field[target_count] = zero
for each target index i:
    if target_mask exists and target_mask[i] is false:
        continue
    locate matching source coordinate
    if no match:
        return missing_active_target_sample(i)
    target_field[i] = source_field[matching_index]
```

**Bramki:** `projection`, `artifact`, następnie `native-field`. Nowy ABI i carrier wymagają migracji wersji, nie reinterpretacji starych manifestów. Stary point-only asset może działać tylko w identity mode.

**Uzupełnienie implementacyjne 2026-09-12:** `load_solved_antenna_drive_basis_projected`
korzysta z tego samego deterministycznego `FieldTetraBvh` co sampler FFT.
Najpierw wykonywany jest szybki lookup identycznych współrzędnych, a dla nowego
węzła — point location w zweryfikowanym `tet4_connectivity` i interpolacja
barycentryczna P1. Maska targetu jest rozstrzygana przed lookupem; nieaktywne
węzły pozostają zerowe. Podpis projekcji rozróżnia wynik interpolowany przez
realizację `p1:<digest>`. Dodano test affine P1 na tet4 oraz pełny zestaw 13
testów ładowania/projekcji; regresja FFT pozostaje 18/18. Nadal otwarte są
`direct_rt0_evaluation_v1`, transfer do natywnego MFEM, formalnie typowane
stany `inside/outside/missing/unsupported` w API oraz kwalifikacja dużych i
mieszanych topologii.

## T10. Ujednolicić analizę k, fazę i równowagę

Uzupełnienie 2026-10-02 (parytet fazy): istniejący test porównujący zespolone
amplitudy regular FFT i direct DFT rozszerzono na cztery okna, obie
normalizacje i jawnie obecne ujemne osie $k$. Test pozostaje nieuruchomiony
na mocy zakazu w worktree; nie stanowi jeszcze numerycznej kwalifikacji T10.

Uzupełnienie 2026-10-02 (lokalny reuse): CLI sprawdza istniejący wynik w
katalogu bieżącego etapu przed próbkowaniem i FFT. Ponowne użycie wymaga
zgodności digestu rozwiązania pola, portu, targetu, płaszczyzny, okna,
normalizacji, komponentu, transformacji i osi `k` oraz strumieniowej
weryfikacji czterech payloadów. Zmieniony input albo uszkodzone bajty kończą
się błędem; dodano regresję źródłową. Hostowy diagnostyczny `cargo check`
przeszedł, test jednostkowy nie został uruchomiony. Cache między runami oraz
klucz z digestem zweryfikowanej równowagi pozostają otwarte.
Manifest i lokalny cache hit są teraz dodatkowo sprawdzane względem
przeliczonych z okna i wejściowej siatki próbkowania `coherent_gain` oraz ENBW;
dla direct/nonuniform liczność wyjściowego k-grid nie zastępuje liczności
próbek wejściowych. Regresje źródłowe z ponownie zahashowanym fałszywym
gainem nie zostały uruchomione z powodu zakazu testów.
Kontrola manifestu i GET API liczą te dwie metryki analitycznie w stałym
czasie/pamięci z sum harmonicznych okien endpoint-inclusive; nie tworzą
tablic długości siatki przy każdym odczycie. Transformacja zachowuje dotychczasowe
okno numeryczne, a porównanie ma tolerancję względną `1e-10` dla błędów
sumowania `f64`. Regresja porównuje wszystkie cztery okna dla małych i
nierównych liczności osi oraz przypadek 10 mln próbek, lecz pozostaje
nieuruchomiona przez zakaz testów.

Uzupełnienie 2026-10-02 (przepełnienie FFT/direct): oba transformatory
odrzucają niefinitywne obliczone amplitudy i moc, a direct odrzuca
niefinitywną fazę `k·r` przed ewaluacją wykładnika. Regresja źródłowa obejmuje
skończone wejścia przepełniające obliczenia; test pozostaje nieuruchomiony
zgodnie z `AGENTS.md`. Jest to fail-closed, nie kwalifikacja dokładności dla
ekstremalnych wektorów falowych.

**Pliki:** `antenna_spectrum.rs`, CLI `execute_antenna_spectrum_requests` przenoszone do `antenna_workflow.rs`, Python/IR spectrum request; testy modułu i nowe `tests/antenna/verify_spectrum.py`.

- [ ] Skorzystać z rozróżnienia missing/outside T09. Regularną płaszczyznę budować w zadanym orthonormal frame; przekazywać rzeczywiste interpolation metadata.
- [ ] Przyjąć fizyczny początek współrzędnych płaszczyzny z definicji request. Dla structured FFT skorygować przesunięcie indeksów względem początku `-L/2`; uwzględnić u i v, włącznie z ujemnymi k.
- [ ] Porównywać zespolone amplitudy regular/direct dla identycznych k. Nie ograniczać testu do normy lub pozycji pików.
- [ ] Ustalić spacing `(N-1)` dla siatki z oboma końcami oraz DFT period `N*spacing`; dokumentacja osi musi wyjaśniać tę różnicę. Nie zmieniać samej osi bez przeliczenia konwencji amplitudy.
- [ ] Sprawdzić unitary i integral_si, gain/ENBW okien oraz jednostkę pola na amper. Jeśli źródło jest na amper, jego squared spectrum nie może być prezentowane jako wynik dla dowolnego prądu bez skalowania.
- [ ] Dla `component=transverse` rzeczywiście wczytać `equilibrium_ref`, sprawdzić jego digest i zgodność targetu, projektować m0 na te same punkty. Brak równowagi oznacza błąd; nie podstawiać zer ani jednolitej osi.
  Do czasu tej implementacji Python i obie wersje walidatora IR odrzucają
  `equilibrium_ref` przy innych komponentach, aby nie ignorować go po cichu;
  `transverse` jest już odrzucany także przez konstruktor Python, nawet z referencją równowagi. Dodano regresje źródłowe Python/IR,
  nieuruchomione z powodu zakazu testów w worktree.
  Publikowalny entry point runnera odrzuca też ręcznie podaną tablicę m0 bez
  certyfikowanego resource loadera oraz zignorowane referencje equilibrium/mode;
  izolowany kernel projekcji nie stanowi dowodu poprawnego artefaktu.
- [x] `mode_basis_ref` nie może być pozornie przyjętym parametrem: do czasu osobnej zweryfikowanej analizy modalnej konstruktor Python i obie wersje walidatora IR odrzucają tę opcję z jawnym statusem unsupported. Nie przekształcać W_H w sprawność transdukcji.
- [ ] Dodać cache analizy zależny od field signature, plane, window, normalization, component i equilibrium digest; zmiana m0 nie unieważnia bazy prądowej.

**Stan implementacji 2026-09-11:** carrier artefaktu publikuje opcjonalny,
zweryfikowany payload `tet4_connectivity`; sampler Rust realizuje
`fem_p1_interpolation_v1` przez barycentryczne P1 i deterministyczny BVH, a
point-only asset działa wyłącznie jako jawne `identity_coordinates_v1`. Testy
obejmują affine vector field, integralność hasha topologii i `outside=zero`.
**Uzupełnienie 2026-09-12:** klasyfikacja i interpolacja tet4 oblicza wyznacznik
po unormowaniu krawędzi lokalnym rozmiarem elementu, więc decyzja o degeneracji
jest bezwymiarowa i nie zawiera już bezwzględnej podłogi `1 m`. Test
publicznego samplera potwierdza to samo obrócone pole afiniczne dla skali
`1 m`, `1 µm` i `1 nm`, a osobny test odrzuca zdegenerowany element
nanometrowy. Zamknięta jest część T09 dotycząca skali P1; nadal otwarte są
`direct_rt0_evaluation_v1`, transfer do native MFEM, kwalifikacja mixed
topology oraz kwalifikacja dużych siatek.
**Uzupełnienie 2026-10-02:** tolerancja `identity_coordinates_v1` zależy teraz
od odstępu płaszczyzny i rozdzielczości współrzędnych `f64`, a nie od samej
odległości od początku układu. Dodano regresję dla siatki mikrometrowej
przesuniętej o 1000 km, odmowę pracy poniżej rozdzielczości współrzędnych
oraz izolację dopasowania od odległych próbek poza żądaną płaszczyzną.
Walidator notatki naukowej i produkcyjne `cargo check` przeszły; testy
jednostkowe nadal nie zostały uruchomione z powodu zakazu w worktree.
Punkt na współdzielonej ścianie ma teraz jawnego właściciela: najniższy ordinal
elementu w zapisanym `tet4_connectivity`, a test wymusza niezależność tej
decyzji od kolejności przejścia BVH.
Nowy plan anteny wymaga niepustej, wyłącznie tet4 topologii nośnika pola, a
runtime powtarza tę kontrolę przed pierwszym wywołaniem native solvera. Mieszana
lub nieobsługiwana topologia nie może już zostać zredukowana do
`identity_coordinates_v1`; stary asset bez topologii zachowuje wyłącznie
jawną ścieżkę kompatybilności point-only. Testy planera i runtime obejmują oba
przypadki. Nadal otwarte pozostają bezpośrednia ewaluacja RT0, transfer MFEM,
pełne rozróżnienie stanów HTTP w generated OpenAPI i kwalifikacja topologii
mieszanej jako osobnej capability.
Opcja `mode_basis_ref` jest teraz fail-closed w obu walidatorach IR; nie można
jej podać do ścieżki source-spectrum, która nie wykonuje analizy modalnej.
Analogicznie `component="transverse"` z dowolnym `equilibrium_ref` jest
odrzucany już na granicy IR, ponieważ runner nie ma jeszcze zweryfikowanego
ładowania i projekcji równowagi na tę samą siatkę próbkowania.
API widma rozróżnia teraz `missing_payload` (HTTP 404) od
`unsupported_topology` (HTTP 422), a metadata endpoint sprawdza obecność
wszystkich czterech binarnych payloadów przed publikacją zasobu.
Inspector opisuje widmo jako bazę pola portu znormalizowaną do `1 A`, bez
przyłożonego waveformu lub deklarowanego prądu drive, oraz wyświetla jednostkę
mocy bezpośrednio z `payloads.power.unit`. Test UI chroni zarówno tę semantykę,
jak i dokładną postać jednostki `(A/m/A)^2`.
**Uzupełnienie 2026-10-02 (OpenAPI):** oba endpointy source-spectrum deklarują
teraz typowany `ApiErrorResponse` dla HTTP 404/422 oraz opisują kody
`missing_payload` i `unsupported_topology`. Zregenerowano śledzone OpenAPI
i typy TypeScript z aktualnego źródła, dodano źródłową regresję kontraktu,
a `pnpm --dir apps/control-room typecheck` przeszło. Test jednostkowy OpenAPI
pozostaje nieuruchomiony zgodnie z zakazem w worktree.
Pozostają: bezpośrednia ewaluacja `direct_rt0_evaluation_v1`, natywny transfer
MFEM, rzeczywiste wczytanie `equilibrium_ref` dla `component=transverse` oraz
kwalifikacja mieszanych topologii i dużych siatek. Sam fail-closed dla
nieobsługiwanej topologii jest zamknięty; nie oznacza to jeszcze implementacji
interpolacji mixed/native MFEM.

**Uzupełnienie 2026-09-12 (preflight T10):** oba publiczne transformatory
`compute_structured_antenna_source_spectrum` i
`compute_nonuniform_k_antenna_source_spectrum` korzystają ze wspólnej walidacji
siatki. Sprawdzane są liczności osi przed odejmowaniem `N-1`, checked product,
zgodność długości próbek, skończony i ortonormalny frame, dodatnie extenty oraz
finite dodatnie spacing. Ścieżka direct dodatkowo odrzuca pusty/niefinite
`k`-grid i checked output/operation count. Invalid request nie może wejść do
FFT/DFT ani wywołać panic przez underflow `usize`.
Manifest widma zapisuje teraz również authored `transform`, `window` i
wersjonowaną `fourier_realization`; dwa wyniki o tym samym kształcie tablic nie
mogą już wyglądać jak ten sam operator tylko dlatego, że mają identyczny
digest danych liczbowych.

**Bramka numeryczna 2026-09-12:** zestaw testów source-spectrum ma teraz 18/18
przypadków. Oprócz zgodności zespolonej structured FFT/direct DFT obejmuje
dwuwymiarowy Hann (`coherent_gain=9/64`, `ENBW=4`), Parsevala dla
`unitary_discrete` oraz relację skali `integral_si` do transformacji unitarnej
przy tym samym polu i siatce. To jest dowód konwencji i normalizacji, nie
kwalifikacja natywnego FEM ani cache analizy.

Niezależny test analityczny konwencji fazy, wykonywalny już teraz:

```python
# %% Oracle fazy; nie uruchamia Fullmag ani solvera
import cmath
import math

count = 4
spacing_m = 1.0
extent_m = (count - 1) * spacing_m
k_rad_per_m = 2.0 * math.pi / (count * spacing_m)
index_fft = 1.0 + 0.0j
physical_dft = cmath.exp(1j * k_rad_per_m * extent_m / 2.0)
corrected_fft = index_fft * cmath.exp(1j * k_rad_per_m * extent_m / 2.0)
assert abs(corrected_fft - physical_dft) < 1e-14
assert abs(index_fft - physical_dft) > 1.0
assert abs(abs(index_fft) ** 2 - abs(physical_dft) ** 2) < 1e-14
```

Test jednostkowy produkcyjnego Rust ma korzystać z tych samych wartości i okna rectangular, wywołując obie rzeczywiste funkcje transformacji. **Bramka:** `just verify-antenna-contracts spectrum`. Commit: `fix: preserve physical phase and sampling in antenna spectra`.

## T11. Wprowadzić preflight ważności modelu i kosztu

**Stan 2026-09-12:** współdzielona polityka `antenna_direct_oersted_budget.v1`
(`1_000_000` par źródło–target) jest zapisana w kanonicznym IR. Preflight
planera odrzuca przekroczenie po zbudowaniu rzeczywistego meshu przewodnika i
nośnika próbkowania, przed wywołaniem native solvera; wrapper RT0 powtarza tę
kontrolę jako zabezpieczenie runtime. Obie pętle wykonawcze charge/steady
transport sumują koszt wszystkich jednocześnie przygotowanych źródeł Oersteda
przed pierwszą ewaluacją, a kontrola pojedynczego wywołania pozostaje drugą
granicą obrony. Sprawdzone są konwersje `usize → u64`, checked multiplication,
granica dokładna, overflow oraz diagnostyka z liczbą elementów, targetów,
ewaluacji i identyfikatorem polityki. Testy planera przechodzą w `fullmag-plan`
(3/3), zestaw referencyjny anteny w `fullmag-runner` (33/33), a kod feature
`fem-gpu` przechodzi hostowy `cargo check`; nie jest to kwalifikacja natywnego
FEM. Kontenerowa recepta Windows nie wystartowała, ponieważ ogólny
`compose.yaml` używa hostowego `FULLMAG_FRONTEND_ROOT` równocześnie jako
linuksowego targetu bind mountu i Docker Desktop odrzuca go jako ścieżkę z
nadmiarowymi dwukropkami. Próba ponowiona 2026-09-12 po starcie Dockera i
udostępnieniu zatwierdzonego rootu storage zakończyła się tym samym błędem
`mount denied ... too many colons`; poprawka rozdzielająca windowsowe źródło
bindu od linuksowego celu kontenera oraz shell-local wrapper z
`MSYS_NO_PATHCONV=1` usunęły tę blokadę. Ponowiony 2026-09-12 test przez
`just verify-fem-solved-antenna-drive-contract` zbudował kontenerowy stos
MFEM/CUDA i przeszedł kontrakt `fem_zeeman_contract`, test layoutu FFI oraz
`native_pack_materializes_solved_antenna_as_preprojected_per_ampere_basis`.
Nie zamyka to pełnej bramki T11: brakuje agregacji między osobnymi blokami/retries i callbackami etapów,
budżetu pamięci i anulowania, diagnostyki pasma `eta_wave`/`eta_skin`, pomiaru
wall-time/peak-memory oraz kontenerowego benchmarku direct RT0.
Uzupełnienie 2026-10-02: `conductor_metrics_for_drive` używa teraz tego samego
wiązania `source_object_id → region → geometry` co planner solve, zamiast
traktować ID jak nazwę geometrii. Regresja źródłowa rozdziela stabilne ID,
nazwę obiektu i nazwę geometrii, a dodatkowo wymusza priorytet ID przy kolizji
z nazwą obcej geometrii; test pozostaje nieuruchomiony. Równania i
próg `eta_wave/eta_skin` nie zmieniły się.
Preflight direct Oersted w plannerze i runnerze odrzuca też `N_s=0` lub
`N_t=0` przy aktywnej ewaluacji. Wcześniej iloczyn par był wtedy zerem i
omijał limit nawet przy ogromnym target buffer; zero aktywnych ewaluacji
pozostaje odrębnym poprawnym przypadkiem. Dodano regresje źródłowe obu
granic; testów nie uruchomiono z powodu zakazu w worktree. Nie zastępuje to
budżetu pamięci ani blokowania targetów.
Uzupełnienie 2026-10-03: planner oblicza z kontrolą przepełnienia i zapisuje
w provenance co najmniej $96N_t$ bajtów czterech równocześnie obecnych
buforów punktów/pola w Rust i natywnym direct Oersted. To dolna granica
znanych buforów, a nie peak-memory ani limit przyjęcia zadania; siatka,
solve prądu, kwadratura i narzut alokatora są poza rachunkiem. Dodano test
wartości i przepełnienia jako kod źródłowy, ale nie uruchomiono go z powodu
zakazu budowy testów Rust. Diagnostyczny `cargo check --locked -p
fullmag-plan` przez zarządzany storage oraz walidacja notatki 0950 przeszły;
kontenerowy runner zgłasza brak konfiguracji. Pełny budżet pamięci,
blokowanie targetów i kwalifikacja natywna pozostają otwarte.
Walidator notatki 0950 i diagnostyczne `cargo check --locked -p fullmag-plan
-p fullmag-runner` przeszły dla tych źródeł; brak kontenerowego runtime i
zakazane testy nie pozwalają nazwać tej granicy zakwalifikowaną.

**Pliki:** nowe planner `antenna_preflight.rs` i runner `antenna_validity.rs`, istniejący IR/plan, `native_fem/steady_transport.rs`, direct tetra options, manifest/DTO; nowy `tests/antenna/verify_budget.py`.

Uzupełnienie 2026-10-08: [checkpoint sumy pamięci cold-load](2026-10-08-antenna-aggregate-memory-checkpoint.md)
opisuje checked sumę manifestu/payloadów przed odczytem oraz fallible reservation
dekodowania. To nie jest peak RAM ani twardy limit. Istniejące
`ram.reservation_bytes` pozostaje minimum rezerwacji, bez zmiany semantyki.
Regresje Rust dodano, lecz nie wykonano; pełny T11 pozostaje otwarty.

Uzupełnienie 2026-10-08: [checkpoint deklaracji pasma Python](2026-10-08-antenna-python-bandwidth-checkpoint.md)
potwierdza brak heurystyki czasu impulsu w klasyfikatorze i naprawę wcześniejszej
akceptacji niepoprawnego override pasma dla sygnałów analitycznych w Python.
Nowe regresje: RED/GREEN 4/4; authoring/export etapów: 23/23. Nie jest to
kwalifikacja klasyfikatora Rust ani wykonania solvera; checkbox pełnej bramki
pozostaje otwarty.

- [ ] Wyliczać przed solve liczbę elementów źródła, targetów, par i rozmiar buforów. Użyć checked multiplication; overflow jest błędem, nie ogromnym zaakceptowanym zadaniem.
- [ ] Zastąpić stałą miliona par jawnie wersjonowaną polityką wykonania. Zachować limit domyślny dopóki benchmark nie uzasadni innego; błąd preflight pokazuje oba rozmiary i koszt.
- [ ] Blokować targety dla ograniczenia pamięci i granic anulowania. Licznik globalny obejmuje wszystkie bloki, porty i retries; nie resetować budżetu dla każdego bloku, aby obchodzić limit.
- [ ] Nie zmniejszać automatycznie gęstości próbkowania. Użytkownik może jawnie zmienić target/rozdzielczość lub zatwierdzić większy budżet obliczeń w konfiguracji badania; proweniencja zapisuje decyzję.
- [x] Dodać diagnostykę `eta_wave`/`eta_skin` z 0950 dla stałej, sinusoidy i sinc/cutoff, z jawnym źródłem `f_max`; dla nieznanego pasma zwracać `validity_bandwidth_unknown`.
- [x] Dodać osobny, jawny kontrakt deklarowanego pasma dla sampled waveform; nie uznawać samego czasu próbkowania za fizyczny `f_max`.
- [ ] Prostokątny pulse i skok nie mają skończonego idealnego pasma. Nie wyznaczać `f_max` wyłącznie jako odwrotności długości impulsu. Wymagać opisania bandwidth/rise-time lub zwrócić brak oceny.
- [x] Ostrzeżenia przeliczać przy zmianie waveform, ale nie stawiać przez to bazy jako stale. Planner publikuje osobną notę dla każdego `SolvedAntennaDriveIR`.
- [x] Dla wielu aktywnych portów agregować wspólne ograniczenie pasma i wspólne źródło pola; obecna diagnostyka pozostaje per-drive.
- [ ] Zapisać measured wall time, peak memory, pairs, refined pairs, error i cancellation latency. Dopiero jeśli direct solver nie spełnia potrzeb, zaprojektować oddzielnie kwalifikowany fast operator; samo zwiększenie limitu nie jest optymalizacją.

Uzupełnienie implementacyjne 2026-09-12: `fullmag-ir` publikuje wersjonowany
`antenna_waveform_bandwidth.v1`. Klasyfikator zwraca `f_max_hz=0` dla stałego
napędu, częstotliwość autorską dla sinusoidy i `cutoff_hz` dla sinc; pulse oraz
piecewise-linear pozostają `validity_bandwidth_unknown`, bez heurystyki
`1/duration`. Planer dopisuje tę klasyfikację do provenance dla każdego
`SolvedAntennaDriveIR`, więc zmiana waveformu odświeża diagnostykę bez
unieważniania statycznej bazy pola. Obliczanie `eta_wave`/`eta_skin` z geometrii
i materiału, agregacja budżetów między blokami oraz pomiar wall-time/peak-memory
pozostają otwarte.

Uzupełnienie implementacyjne 2026-09-21: planner publikuje również wersjonowaną
notę `antenna_validity.v1`. Dla znanego pasma rozwiązuje geometrię przez
`antenna_target_projection → antenna_field_solve_stage → geometry.source_object_id`
i odczytuje `length_m`, `thickness_m` oraz `conductivity_s_per_m` wyłącznie z
`MicrostripAntenna` lub `CpwAntenna`. Obliczane są wielkości
$\eta_{wave}=L_{max}f_{max}/c$ oraz
$\eta_{skin}=t_{max}/\delta$, gdzie
$\delta=\sqrt{2/(2\pi f_{max}\mu_0\sigma)}$; próg ostrzeżenia wynosi
`0.1`, zgodnie z 0950. Brak skończonego pasma, brak geometrii lub niepoprawne
parametry pozostają jawnie `status=unknown`; nie jest używana heurystyka
`1/duration`. Jest to preflight diagnostyczny, a nie dowód poprawności
solvera ani kwalifikacja GPU. Szczegóły i ślad weryfikacyjny zapisano w
`docs/validation/antenna/validity-diagnostics-2026-09-21.md`.
Noty są dołączane także do `AntennaFieldSolvePlanIR`, więc samodzielne
obliczenie bazy anteny zachowuje te same parametry proweniencji co późniejszy
Relax/Run.

Uzupełnienie 2026-10-02 (zakres numeryczny): skończone parametry wejściowe,
których iloczyny przepełniają `f64` przy obliczaniu `eta_wave` lub `eta_skin`,
nie są już publikowane jako `status=warning` z `inf`. Planner zwraca
`status=unknown reason=validity_numeric_overflow` z parametrami wejścia.
Dodano regresję źródłową; walidator notatki naukowej i diagnostyczne
kontenerowe `cargo check -p fullmag-plan` przeszły. Test jednostkowy pozostaje
nieuruchomiony zgodnie z zakazem w worktree.

Uzupełnienie implementacyjne 2026-09-21 (deklarowane pasmo): IR publikuje
`AntennaWaveformBandwidthDeclarationIR` jako opcjonalne pole
`SolvedAntennaDriveIR.bandwidth_declaration`, a Python DSL udostępnia
`AntennaWaveformBandwidthDeclaration(f_max_hz=...)`. Dla `Pulse` i
`PiecewiseLinear` klasyfikator pozostaje `validity_bandwidth_unknown`, dopóki
autor nie poda skończonego, nieujemnego `f_max_hz`; sama długość impulsu,
odstęp węzłów, czas próbkowania ani częstotliwość Nyquista nie są używane jako
fizyczne pasmo. Zgodna nota provenance ma
`source=declared` oraz
`declaration_schema=antenna_waveform_bandwidth_declaration.v1`. Deklaracja jest
opcjonalna, kompatybilna ze starym JSON przez `serde(default)`, i nie zmienia
niezmiennej sygnatury statycznej bazy pola. Ekspozycja tego pola w zasobie
OpenAPI/Inspectorze pozostaje elementem T14.

Uzupełnienie implementacyjne 2026-09-21 (agregat wielu portów): planner
publikuje dodatkową notę `antenna_waveform_bandwidth_aggregate.v1` dla
wspólnego źródła `H_ant_basis`. Dla drive’ów potencjalnie aktywnych w danym
`StudyIR` agreguje konserwatywnie `max(f_max_hz)` i zapisuje listę drive’ów oraz
portów. `AllTimeEvolution` jest filtrowane przez rodzaj study, natomiast
`StageIds` pozostaje potencjalnie aktywne, bo pojedynczy `ProblemIR` nie zna
jeszcze konkretnego stage boundary. Jeśli choć jeden taki drive ma nieznane
pasmo, agregat ma `status=unknown` i wymienia jego ID; nie jest tworzona
fałszywa liczba z czasu próbkowania. Nota trafia zarówno do zwykłego planu
wykonania, jak i do samodzielnego `AntennaFieldSolvePlanIR`.

Kontrakt arytmetyczny testu:

```rust
#[test]
fn pair_budget_is_global_and_checked() {
    assert_eq!(1_000_u64.checked_mul(10_000), Some(10_000_000));
    assert!(10_000_000_u64 > 1_000_000);
    assert_eq!(u64::MAX.checked_mul(2), None);
}
```

Powyższy oracle uzupełnić testem rzeczywistego plannera: input 1000×10000 przy limicie 1e6 jest odrzucony **przed** wywołaniem current solve. **Bramka:** `budget`; benchmark obejmuje mały fixture oraz co najmniej jeden realistyczny target, z danymi zamiast deklaracji „szybko”.

## T12. Związać lifecycle, cache i anulowanie z wykonaniem

### Checkpoint 2026-10-08 — jednoznaczny manifest i kontrolowany cold-load

Aktualny przyrost obejmuje odmowę duplikatów JSON, manifest-derived read limits,
kontrolę rozmiaru przed alokacją i otwarcie przez zweryfikowany uchwyt systemowy.
Nie kwalifikuje runtime ani fizyki. Zakres, niewykonane regresje Rust i otwarty
globalny budżet RAM opisują [checkpoint JSON](2026-10-08-antenna-manifest-duplicate-keys-checkpoint.md)
oraz [checkpoint cold-load](2026-10-08-antenna-bounded-cold-load-checkpoint.md).

### Checkpoint 2026-10-05 — terminalny build, dwie próby RAM i poprawka eksportu

**Commit fragmentu:** `35ae2d130563faae2c78331a04aa6d625b5407bd`
(`fix(python): lower antenna runtime actions through stage IR`), dokładnie
`helper.py` i samodzielny `test_antenna_run_config_export.py`.
Mała kopia samych źródeł Python z bazowego
`5999324c59dd9398adc3bfbbb61557b17a7199d9` w taskowym tmp storage
odtworzyła RED (brak definicji pierwszego solve). Po nałożeniu wyłącznie
byte-identical poprawki helpera ten sam test jest GREEN, **1/1**, exit 0;
sprawdzono rzeczywistą ścieżkę importu i SHA-256 helpera. To nie był
Python overlay natywnego pakietu ani zmiana kapsuły. Fixture jest jawnie
testem serializacji, nie fizycznie kompletnym modelem solvera.
Review samodzielności fragmentu: PASS; staged diff obejmował tylko dwa
pliki i przeszedł check. Pozostały zależny WIP zachowano bez stage.
Test SHA-256:
`0791157e435b4061fcbf96dec39b712b9b9446a352dd5d7db7b8afba070b2a2e`.
Commit oraz nowy test powstały po capture poniższego jobu; helper w tej
kapsule ma już te same poprawione bajty, ale bazowy commit buildu pozostaje
`5999324c59dd9398adc3bfbbb61557b17a7199d9`, nie nowy HEAD.

**Nowy build poprawki:** `db180d706d8544ec9325d24be260a8fc`, profil
`fem-cpu-release`, stan `running`, exit null. Bazowy HEAD:
`5999324c59dd9398adc3bfbbb61557b17a7199d9`. Kapsuła
`ae6dca833d3d443d9860c15fb7365475` zawiera 7428 wpisów i dokładnie 60
jawnie wskazanych nowych plików; source digest:
`59c1befb1648d9f42aa8550bf02bc4acb2669accd3611e483e158cd8b4c74c91`,
native snapshot:
`fd00dd7e67bf574af0e9e66d587b2d7f25ed492d17c2fa68e98c84212733c4e6`.
Sprawdzono wpisy manifestu: helper SHA-256
`5b0af0c1b260213b91e028b5e76c25acef71185eccd1d3086d3648456697f563`,
test przykładu `fad6a12f887b4d8368c404dcfe145167bde8cabff32346225328b53b76af8ccb`,
launcher RAM `fe34643d959fd693c2e0dfc2e3e5514aba8e7c279f660e0ee45cd0d3e85a9763`.
Edycje wstrzymano podczas capture; ten wpis powstał później i nie należy
do kapsuły. Zdrowy koordynator przed submission miał accepting_jobs true,
worker_error null i pusty aktywny slot; nie uruchomiono drugiego ciężkiego
buildu poza kolejką. Nie ma jeszcze terminalnego receipt nowego pakietu.

Build `fad6f31076494ca39938191358e77159` otrzymał terminalne
`succeeded`, exit 0; potwierdzono coordinator receipt i komplet 126 artefaktów.
Build receipt SHA-256:
`8faad51942ebe87172887e5e8af856fe07486c3c09736e91927d6ec2b8c73dd7`.
Worker zakończył się o 16:15:14.928068425 UTC bez OOM; terminalny stan
kolejki potwierdzono o 16:25:35 UTC. To dowód buildu dokładnej wcześniejszej
kapsuły, nie rozwiązania anteny ani późniejszych poprawek.

W zatwierdzonym trybie RAM rzeczywiście uruchomiono dwie próby, obie
zakończone exit 13, bez OOM, przed natywnym solve V/RT0/H:

- Run `da98de1a4f854286b4b7a764a63025b0`: odziedziczony
  `FULLMAG_API_PORT=8081` żądał istniejącego API w trybie headless.
  `scripts/run_managed_antenna_ram.py::scientific_spec` ustawia teraz
  jawne `FULLMAG_API_PORT=0` oraz `FULLMAG_STATE_DIR=/ram/user-state`;
  root sesji i cache pozostają w RAM. **33 testy launchera PASS**, exit 0.
- Run `ae4679a1e2fe4eb3a76b5724ed80f9eb`: Python wyeksportował akcję
  antenową z `definition`, a Rust oczekiwał `stage_id` i portów.
  Pełny log zawiera `missing field stage_id` podczas deserializacji.
  Nie był to błąd solvera prądowego ani wyniku pola.

Poprawiono właściciela granicy
`packages/fullmag-py/src/fullmag/runtime/run_config_export.py::_runtime_stage_action`:
pełna definicja bieżącego solve trafia do jego `ProblemIR`, zaś akcja
przekazuje wyłącznie `kind`, `stage_id`, `port_mode_ids`, zgodnie z
`crates/fullmag-cli/src/types.rs::ScriptExecutionStageAction` i
`crates/fullmag-cli/src/step_utils.rs::resolve_explicit_stage_action`.
Authoring nadal przechwytuje stan przed akcją. Nie kopiuje się pełnego
root IR do wcześniejszych etapów; brak definicji i konflikt ID są odrzucane,
równa definicja nie jest duplikowana, inne akcje pozostają niezmienione.

Regresja rzeczywistego `helper.main export-run-config` była RED przed
poprawką; po uzupełnieniu materializacji definicji jest GREEN.
**32 interpretowane testy PASS**, exit 0 (przykład oraz stage workflow).
Nowy test wieloetapowy reimportuje skrypt: wcześniejszy Run ma zero
definicji, pierwszy solve tylko swoją, drugi obie, root obie; każda akcja
ma dokładny kształt referencyjny. Pokryto konflikt, brak definicji,
deep-copy i unchanged nonantenna actions. Niezależny review: PASS po
dodaniu tej regresji. Kompilacji unit tests nie wykonywano.

Sandbox początkowo odmówił utworzenia pytest tmp na D:; interpretowane
testy wykonano po zatwierdzonej eskalacji, bez przenoszenia danych na C:.
Kontenery, receipts i pełne logi obu nieudanych prób zachowano.
Starej kapsuły ani pakietu nie nadpisano i nie dodano Python overlay.
Poprawka wymaga nowego snapshotu i pełnego buildu tej tożsamości,
następnie ponowienia dokładnego testu RAM i porównania z oracle.
Actual native V/RT0/H, full closure, reuse/LLG/FFT i trwały SessionStore
nadal **NOT VERIFIED**; T05/T06/T12/T18 pozostają otwarte.

### Checkpoint 2026-10-06 — globalna kwadratura v3: źródła i diagnostyki, native jeszcze niewykonane

Aktualizacja 2026-10-05 22:50 UTC, lokalna data 2026-10-06. HEAD bez zmiany;
native/IR operator `fem_oersted_direct_tetra_quadrature.v3`, resolved preset
`external_lead_direct_defaults.unqualified.v3`, floor 0. Duffy zachowuje
poprawną transformację v2. Całe H targetu kontroluje suma estymatorów finalnych
liści oraz oddzielny heurystyczny wskaźnik R; nie jest to rygorystyczny bound.
Rodzic znika z ledgeru przy dodaniu 8 dzieci, depth-blocked leaves pozostają.
Największy dostępny estymator jest dzielony; końcowa pełna suma H/E/R decyduje
o akceptacji, bez floor i bez acceptance slack. Limity 1 mln finalnych liści
oraz 100 mln attempted kernel samples i full-ledger visits są jawne;
ProjectField współdzieli work budget między punktami i trzema komponentami.

Nested field framing v2 zachowuje per-target E/R/tau/leaves/samples/visits,
versioned tokens/caps i dwa dodatkowe liczniki całego wywołania. Decoder
akceptuje wyłącznie zgodne literalne kombinacje archive v1/v2 oraz current
v3; archived bytes nie są przepisywane, request-bound solve wymaga current.
FastTwoSum odmawia dodatniej sub-ULP reszty przy E równym tau. Przepełnienie
mianownika kernela daje jawny failure, nie pozorne zero. Regresje Rust/C++
uzupełnione, lecz NIE skompilowane ani wykonane zgodnie z zakazem unit builds.

RED model/source: 3 FAIL/9 PASS przed implementacją ledgeru; nowy syntetyczny
v3 association test RED 1 FAIL na starym framingu. Końcowy zestaw 13 plików
Python: 233 PASS + 29 subtests PASS, 13,43 s. Wcześniejsze wywołanie nie
zebrało testów przez brak PYTHONPATH; poprawiono ścieżkę lokalnego DSL bez
instalacji i bez zmiany asercji. Wszystkie TEMP/TMP/basetemp pod D storage.
Native owner/codec review i follow-up overflow/sub-ULP gate source PASS.
Focused scientific source-map validator exit 0; brak render/publication proof.

Następnie: jeden snapshot w istniejącej kolejce profilu fem-cpu-release,
pełny terminalny receipt/source/artifact validator, a dopiero potem fixed RAM
V/RT0/H bez LLG/Relax, z tym samym oracle i wejściem. Nowy inside/near/face/edge
runtime oraz projection science pozostają osobnymi nieodebranymi bramkami.
Stary sixth H FAIL nie jest zamknięty przez testy interpretowane. Pełnego
modułu i integracji nie oznaczać jako gotowych.

### Aktualizacja checkpointu v3 — immutable build w toku

Zlecono build `e57249b5b5d1493b9949204336efcbef`, sequence 32,
request key `antenna-global-target-v3-20261006-v1`, profil fem-cpu-release.
Capture `58d0bc66f471465c83a134d400647cbd`, bazowy HEAD
`202bbed4fff8c72099ef17489134bb1df911c090`, source digest
`d7ec5343f7d45c6000b9127684e20f86240eb8e1fa3bcf7d1c7fb7c743445cb4`,
native snapshot
`b316947eb6f3012c916b6b52ce96188950ad4a150021820cd28d63ad5160880e`.
Jawnie włączono 72 nieśledzone pliki; 21 istotnych hashy źródeł i unchanged
fixture sprawdzono względem manifestu: PASS. Stan odczytany: running, bez
terminalnego wyniku. Nie uruchomiono starego pakietu ani nowego RAM solve.
Checkpoint źródłowy zapisano w canonical D storage, pod
`tmp/<worktree-id>/current-source-oracle/global-target-v3-source-checkpoint-20261006.json`,
SHA-256 `94ae647d49733c884568415063386dd348cc84107854e65f363b98bc5391a68d`. Ten plik dotyczy stanu źródeł i zlecenia,
nie dowodzi native execution. Plan uzupełniono po capture; późniejsza
adnotacja o zleceniu nie jest częścią frozen source digest.

### Checkpoint 2026-10-06 — publikacja v3: required source gaps i oczekujący pełny pakiet

Odczyt 2026-10-05 23:28 UTC. Ten sam job i kontener są live; natywne
podetapy release zakończyły się poprawnie (8 min 41 s, 6 min 18 s,
2 min 01 s), a launcher FEM CPU jest zainstalowany w pakiecie. Full build
jest w fazie frontend dependencies; nie ma jeszcze terminalnego receipt.
`scripts/local_runner/worker_entrypoint.py::verify_source` sprawdził pełny
manifest digest, wszystkie hashe oraz dokładny skład kapsuły: 7442 pliki,
exit 0, odczyt 23:19:55 UTC. Nie jest to runtime ani physics proof.

Niezależny read-only review regularnej publikacji zidentyfikował required
luki T06/T09/T12; nie zmieniono kodu, build capsule ani progów naukowych:

- [ ] **Eksport i adapter:** `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp::solve_rt0` emituje nazwę v3, ale gubi per-target E/tau/R/leaves/work counters, global work counters oraz scope/policies/caps/floor. `crates/fullmag-runner/src/native_fem/steady_transport.rs::validate_direct_oersted_convergence` sprawdza historyczne zero unconverged/max-pair-error, nie pełny v3 record. Wprowadzić wersjonowany bounded eksport i typed walidację z dokładnym powiązaniem z H/kolejnością; nie zmieniać w miejscu ABI v1 ani nie rozbudowywać `diagnostics_json[1024]` o nieograniczoną tablicę.
- [ ] **Publikacja i load:** `crates/fullmag-runner/src/antenna_field_solution.rs::build_antenna_field_solution_artifacts` kopiuje niezwalidowany JSON i wpisuje ready, a `StoredBasisManifest` nie zachowuje diagnostics ani balance digest. Zachować i walidować numerical acceptance niezależnie od SHA/normalizacji. To wcześniejsza luka, nie dowód, że kernel publikuje failed H. Jednoznacznie powiązać raw measured-current diagnostics z bazą H/current, również dla current różnego od 1 A; vector-potential zachowuje odrębny kontrakt.
- [ ] **Verifier:** `tests/antenna/verify_field_convergence.py::read_solution` literalnie wymaga v1 i odrzuca regularny v3 output. Wprowadzić właściwy framing i pełną walidację v3, nie samą whitelist wersji. Legacy pozostaje historycznym lokalnym estymatorem, nie globalnym certyfikatem. Zachować trzy identyczne fizyczne carriers i obecne progi L2/Linf.

Regresje muszą obejmować wielopunktowy eksport większy od starego 1024-byte
JSON, missing/mixed/future framing, caps/counts/work sums, nonfinite,
E+R przekraczające tau, sub-ULP dodatnie R przy E=tau, rehashed manifest
mutations i current różny od 1 A. Syntetyczny parser nie zastąpi trzech
poziomów regularnego native solve i niezależnego wzorca pola.

`DirectTetraQuadrature::ProjectField` jest odrębną reference path:
agreguje pracę powtarzanych ocen komponentów, nie zachowuje per-target
ledgeru i nie jest znalezionym runtime producerem regularnego manifestu.
Nie przedstawiać jego countów jako unikalnych targetów ani jego source
review jako qualification projekcji. Fixed RAM korzysta z
`antenna_external_lead_solution.v1` i accepted bundle; powyższe luki
nie blokują zatwierdzonego V/RT0/H, lecz jego inspection-only PASS
nie zamknie reuse/LLG/FFT ani regularnej publikacji.

Raport źródłowy z ośmioma hashami zapisano w canonical storage pod
`tmp/<worktree-id>/current-source-oracle/global-target-v3-publication-source-review-20261006.json`,
SHA-256 `ccf46ad7a902b70af237c97d413c22d088353957dfa395f018748199ad8cb36a`.
Kolejność: terminalna weryfikacja tego samego full build → dokładny
approved RAM V/RT0/H → kontrakt naukowy i naprawa regularnego eksportu,
publication/load/verifier → nowy snapshot i adekwatne bramki.
Ta adnotacja i raport powstały po capture i nie należą do jego digestu.

### Checkpoint 2026-10-06 — siódmy fixed RAM v3: V/RT0/H PASS, regularna publikacja nadal otwarta

Stan 00:13 UTC. Dokładny job `e57249b5b5d1493b9949204336efcbef`,
capture `58d0bc66f471465c83a134d400647cbd`, HEAD
`202bbed4fff8c72099ef17489134bb1df911c090`, source digest
`d7ec5343f7d45c6000b9127684e20f86240eb8e1fa3bcf7d1c7fb7c743445cb4`,
native snapshot
`b316947eb6f3012c916b6b52ce96188950ad4a150021820cd28d63ad5160880e`:
terminalny succeeded/0. Trzy etapy exit 0; pełny validator receipts,
trusted/source binding oraz 126 artefaktów (330295154 bytes) PASS,
pełna kapsuła 7442 plików PASS. Build receipt SHA-256
`f4b2e88b5dbbaa74a8ce4fa875f59caaa68bea17c93f5541ce47558cecdda011`,
terminal receipt SHA-256
`7eb8bab6266334e93d8b10098ac68c0ac92012bb8004fb93ec01d9b7cb3517a7`.

Zatwierdzony run `8031eeff9ebf4ce28cca1fe5e8613329` użył tylko tmpfs
SessionStore; solver exit 0, isolation/startup identity PASS, total_steps=0,
bez LLG/Relax. Nie zmieniono trwałych zabezpieczeń ani fixture. Niezależny
`scripts/compare_managed_antenna_ram.py::compare` zakończył się exit 0:
V/RT0/exact bundle-observable association/H PASS. Progi oracle niezmienione:
V 1e-8 V; H atol 1e-8 A/m + rtol 1e-6 względem normy referencji.
Maksymalny błąd V 1.1102230246251565e-16 V; RT0 108 faces/36 elements,
max face error 2.220446049250313e-16 A, element flux sum 0 A.
Maksymalny błąd wektorowy H 6.760249178929324e-9 A/m; stosunki
błąd/bramka dla czterech punktów: 0.0692114367, 0.0701127733,
0.0948620225, 0.0157304640. Szczegółowe E/tau/R i liczniki zapisano w
`DOC-ANCHOR:antenna-global-target-v3-fixed-ram-evidence` kanonicznej noty.

To zamknięcie wcześniejszego fixed H FAIL, **nie całego T06/T12**.
Wszystkie punkty są outside-source, prąd 1 A; retained native weights
nie są certyfikatem MFEM normalization. Host wykonuje bounded partial
extraction, nie full native codec/input-pin ani exact native tau/history
proof. Near/inside/Duffy runtime, closure, regularna publikacja/load/
verifier, normalizacja przy innym prądzie, projekcje, reuse/LLG/FFT,
cztery lane, UI i trwałość pozostają niezakwalifikowane.
Trzy required checkboxy poprzedniego checkpointu pozostają otwarte.

Pełny raport `seventh-ram-global-v3-comparison-20261006.json`, SHA-256
`0a396dcb6fa9b0b9e64459c21e6c9417522dae0782f869aaf4efbe01dc9a7d8c`;
checkpoint `global-target-v3-runtime-checkpoint-20261006.json`, SHA-256
`cf2f71b391347923eb6cd9805e278cf443a3eeb29cbfe64028b19f0397246b7c`.
Oba pod `storage/tmp/<worktree-id>/current-source-oracle/`.
Solver log SHA-256
`6ae9420fd2972390c078f3b181caa1ee4228968f811ec70af860e57a85cedd3b`.
Raporty i starsze receipts/FAIL pozostają niezmienione; nowe adnotacje
powstały po capture i nie należą do digestu kapsuły.
Następny krok: kontrakt raw H/xyz/ledger → normalized basis, wersjonowany
bounded eksport bez zmiany v1 ABI, typed publish/load/refusal gates,
verifier v3 i adekwatne regresje; następnie nowy snapshot/managed build.
Kompilowanych unit tests nie wykonano. Cały cel i cykl integracji aktywne.

### Checkpoint 2026-10-06 — R1: append-only native snapshot zapisany źródłowo

Po odbiorze siódmego fixed RAM wdrożono źródłowo native producer
`fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1`,
osobny `fullmag_fem_direct_oersted_snapshot_result_v1` i odpowiadające
deklaracje `fullmag-fem-sys`. Przed kodem zapisano science contract
`DOC-ANCHOR:antenna-global-target-v3-regular-export-contract`.
Dotychczasowe request/result ABI v1 i `diagnostics_json[1024]` nie
zmieniają layoutu. Nowy caller-owned bufor zachowuje pełne raw xyz/H/
E/tau/R/leaves/work, parametry/caps/policy i source digest jednego solve.
96-byte rekord, 896-byte header, maksymalnie 1000000 rekordów.
Nie dodano drugiego source solve ani nowego publicznego Python/IR API.

Interpretowane źródłowe/ctypes layout checks: RED 3 FAIL + 2 missing-symbol
ERROR + 1 PASS; po implementacji i rozszerzeniu 8 PASS. Nie wykonują C++
ani Rust. Początkowy launcher pytest był niedostępny; nowy własny harness
używa standardowego unittest bez instalacji zależności. Native static
asserts będą egzekwowane przez build produkcyjny, nie przez te testy.
Niezależny source review po wymaganym doprecyzowaniu failure semantics:
bez dalszych Required. Za krótki layout nie jest zapisywany; error status
zabrania konsumpcji każdego outputu. Dostatecznie duże non-null wyniki
mają wyzerowane published lengths/tokens.

**R1 pozostaje otwarte:** runner nadal używa historycznego symbolu i
nie zachowuje pełnego snapshotu. R3 publish/load/raw→per-A oraz R2
verifier również pozostają required. Nowy eksport nie był w kapsule
siódmego RAM; jego PASS nie kwalifikuje tego symbolu. Najbliższy krok:
pełny managed build nowego snapshotu, potem typed adapter oraz osobny
binary artifact/publish/load/verifier bez promotion archive/local error.
Kompilowanych unit tests ani nowych scenariuszy naukowych nie wykonano.

Build przyjęty: job `5d2e8e253c58405c9d44237cd9d2bce2`, seq 33,
profil fem-cpu-release, request key `antenna-direct-snapshot-20261006-v1`,
stan running, exit null. Capture `e212791b4fa44f93b5c3efe7c90cf234`,
source digest
`e7ad2d0af36e146e448bf1146b8ea07017fff88f570eee98fe887a419e17441c`,
native snapshot
`ed6129f2c9b11784b3ce2fbe947a225a2dbed2b4b6e8ddb28f26eebfd1e743ab`,
HEAD `202bbed4fff8c72099ef17489134bb1df911c090`.
73 jawne untracked inputs, pełny `verify_source` manifest/digest/
hash/exact membership PASS dla 7443 entries; 4 nowe source pins PASS.
Odczyt działającego koordynatora: worker_alive=true, worker_state=running,
worker_error=null, active_jobs zawiera dokładnie ten job. Terminalny
receipt i artefakty jeszcze NOT VERIFIED. Nie restartować/reenqueue
na podstawie timeout lub braku logu fazy przygotowania.

Dowody w `storage/tmp/<worktree-id>/current-source-oracle/`:
`direct-oersted-snapshot-source-checkpoint-20261006.json`, SHA-256
`32fe7cc95dfdd4c9204dd42424b8dc316dc2de6501ae3c860959148331f8bd0d`;
`direct-oersted-snapshot-managed-build-checkpoint-20261006.json`,
SHA-256 `7deb24acdfdfdcf0dbe9904ad71619bad7692900c6573fa0ac305646cb8ce208`.
Ta adnotacja joba powstała po capture i nie należy do jego digestu.

### Checkpoint 2026-10-06 — R1: typowany odbiór snapshotu podłączony źródłowo

Po poprzednim checkpointcie native producenta regularny adapter runnera
wywołuje jeden `fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1`.
Nowy `steady_transport/direct_oersted_snapshot.rs` zachowuje pełny owned raw
snapshot w `NativeFemSteadyTransportRt0Result.oersted_quadrature_snapshot`.
Sprawdza własność/rozmiary bufferów, literalne tokens/caps/options, źródło,
ordered xyz/H bits, exact raw tau z nested hypot/FMA, FastTwoSum E+R,
leaf/depth/refinement conservation oraz sumy pracy z checked arithmetic.
Nie dereferencjonuje returned pointer i nie powtarza solve. Thin summary
nie zależy już od 1024-byte JSON-u; OE-F2 pozostaje odrębne, snapshot=None.

Nowe interpretowane source/model regresje: RED 1 FAIL/1 missing-file ERROR
i 2 PASS, następnie 4 PASS. Cztery Rust regresje są zapisane, lecz nie
kompilowane ani wykonane (zakaz użytkownika). Niezależny read-only review
nie znalazł Required; nie jest dowodem kompilacji ani runtime. Stan science
opisuje `DOC-ANCHOR:antenna-global-target-v3-regular-adapter`.

**R1 runtime nadal NOT VERIFIED.** Aktywny job
`5d2e8e253c58405c9d44237cd9d2bce2` obejmuje wcześniejszą kapsułę bez tych
zmian Rust. Nie przypisywać mu tej implementacji. Kontener workera został
sprawdzony jako działający; nie uruchomiono drugiego ciężkiego buildu.
R3: downstream publisher nie utrwala jeszcze owned raw snapshotu.
Następne wymagane prace to osobny bounded binary artifact i thin ref,
związanie raw→per-A przy dowolnym measured current, walidacja publish/load
oraz R2 verifier odmów także po rehash. Nie uznawać istniejącego ready/SHA
za globalną kwalifikację. Brak nowych science fixture, LLG lub Relax.
Pełny plan T00–T18 oraz integracja pozostają aktywne.

Nowa kapsuła została przyjęta jako job `7cd410e7025143c8aae5a44ba796ec4e`,
seq 34, request key `antenna-direct-adapter-20261006-v1`, profil
fem-cpu-release, queued/exit null. Capture
`6ae77095bfd546428c2f342178739742`, source digest
`913886994f11381cb5d581be0c7bced163bb1e51b27b66f1f59d7086039e858e`,
native source snapshot
`14bc8183d975e6fc685e4e6be84a02aae18cde53502311be97133c35c0907a1f`.
Pełny `verify_source` sprawdził manifest/digest, wszystkie hashe i exact
membership: 7445 entries, 75 jawnych untracked inputs, 3 adapter pins PASS.
Sukces produkcyjnego builda, receipt i jego artefakty nadal NOT VERIFIED.

Dowody: `storage/tmp/<worktree-id>/current-source-oracle/`
`direct-oersted-snapshot-adapter-source-checkpoint-20261006.json`, SHA-256
`4066e35db8ea917c95546a24e453c107f92869e18c4eacee2d02397daf82e8e8`,
oraz `direct-oersted-snapshot-adapter-managed-build-checkpoint-20261006.json`.
Ta adnotacja joba została dopisana po capture i nie należy do jego digestu.
Zależny WIP zachowany; brak nowego commita oderwanego od niezatwierdzonych
native/source/ABI zależności. Następny bezpieczny krok kodowy to R3, nie
ponowienie niezmienionego zielonego fixture ani promocja istniejącego ready.

<!-- DOC-ANCHOR:antenna-retained-native-tau-bit-checkpoint -->
### Checkpoint 2026-10-06 — retained native tau: cztery bitowe porównania PASS, nie pełny parity

Odczytano zachowany fixed RAM `8031eeff9ebf4ce28cca1fe5e8613329` z jego
konkretnym `stage-000` record; bez fallbacku latest i bez nowego solve.
`tests/antenna/direct_quadrature_evidence.py::exact_tolerance` odtworzył tau
z tych samych raw H. Cztery wartości Windows Python 3.12.14 są bitowo zgodne
z retained Linux native FEM CPU: 4/4 PASS, 0 ULP. Nie zmieniono progów,
nie dodano ULP allowance. Dokładne hashe, hex wartości, parametry, zakres
i ograniczenia w nocie 0950, anchor
`DOC-ANCHOR:antenna-retained-native-tolerance-bit-evidence` oraz zapisanej
sondzie/evidence `retained-native-tau-bit-*20261006.*` w current-source-oracle.

To partial bounded inspection read i porównanie finalnych tolerancji;
nie pełne odtworzenie native bundle/input pins ani dowód wszystkich
argumentów hypot/FMA, pośrednich norm lub docelowego Python runtime.
R2 trzy native poziomy/provenance i R3 publication/runtime nadal wymagane.
Pełny moduł, cztery lane, LLG/FFT/UI, trwałość i integracja nadal otwarte.
Managed seq 34 `7cd410e7025143c8aae5a44ba796ec4e` odebrany terminalnie:
native-build, frontend-dependencies i frontend-build exit 0, trusted hashy,
126 artefaktów i cała kapsuła 7445 plików (75 untracked) PASS.
Weryfikowano bazę `202bbed4fff8c72099ef17489134bb1df911c090`, source digest
`913886994f11381cb5d581be0c7bced163bb1e51b27b66f1f59d7086039e858e`
i native snapshot `14bc8183d975e6fc685e4e6be84a02aae18cde53502311be97133c35c0907a1f`.
Dowód `managed-R1-adapter-package-evidence-20261006.json` w current-source-oracle.
To build R1, nie runtime/fizyka ani R3. Seq 35 running.
Wcześniejszy timeout/124 observera nie był failed/cancelled; nie restartowano joba.

<!-- DOC-ANCHOR:antenna-managed-snapshot-openapi-import -->
### Checkpoint 2026-10-06 — import OpenAPI snapshotu: raw/receipt/proof PASS, R3 nadal oczekuje

`apps/control-room/scripts/normalize-openapi-build-identity.mjs::validateManagedSnapshotOpenApiReceipt`
wiąże raw-byte SHA i rozmiar z receiptem oraz SHA receiptu z sąsiednim proof.
Wymaga kompletu spodziewanych pinów, rzeczywistego clean/dirty identity,
poprawnych schema/state/exit, success/input verification/cleanup flags i
zgodności hashy artefaktów między dowodami. Generator wywołuje tę bramkę
przed normalizacją i przed atomową podmianą JSON. Domyślny clean import oraz
odrębny native receipt pozostają bez osłabienia. Nie zmieniono Python/IR,
rodzin resources, commands, events, codecs ani zachowania UI/viewportu.

| Flaga generatora | Typ/domysł | Jednostka | Walidacja i znaczenie | Python/IR |
|---|---|---|---|---|
| `--input` | optional string, domyślnie dotychczasowy codegen | $1$ | dla snapshotu wymagany absolute `receipt-parent/stdout.raw.json`, bounded 64 MiB | brak zmiany |
| `--expected-commit` | optional string, wymagany z inputem | $1$ | 40 lowercase hex, exact base commit | brak zmiany |
| `--expected-snapshot` | optional string, wymagany z inputem | $1$ | 64 lowercase hex, exact native identity | brak zmiany |
| `--expected-source-digest` | optional string, wymagany z snapshot receipt | $1$ | 64 lowercase hex, exact capsule digest; bez receipt odmowa | brak zmiany |
| `--managed-snapshot-receipt` | optional string, default brak | $1$ | absolute bounded 16 MiB, sąsiedni bounded proof 16 MiB; exclusive z native receipt; bez inputu odmowa, bez Cargo fallback | brak zmiany |

RED managed route `8317c818c2cf4ee4891a5d16ccc3ce9d`: 5 nowych FAIL z braku
opcji CLI, 17 istniejących PASS. GREEN `e62a5212213848c2b179c1608811a29d`:
22/22 PASS, exit 0, bez SKIP i bez kompilacji. Pięć nowych testów obejmuje
clean/dirty snapshot, zmienione raw/receipt bytes, 18 mutations receipt,
8 mutations proof, odmowy ścieżek/opcji i zachowanie poprzedniego kontraktu.
API hygiene `9ce934eb7de24fadabeadbe882abad89`: PASS. To lekkie source checks,
nie runtime/nauka ani browser qualification. Walidator odczytał rzeczywisty
R1 seq 33 raw 1562245 bytes z hashami poprzedniego checkpointu: PASS,
raw unchanged; brak DTO R3 potwierdzony, generated JSON/TS bez zmiany.
Pierwsza dodatkowa sonda odczytu miała EISDIR z kolizji argv z CLI guard;
poprawiono wyłącznie argv sondy, drugi odczyt exit 0. Nie ukrywać tego jako
nieudanej regeneracji: żaden generator nie publikował tego starego kontraktu.

Granica zaufania: zgodność i hash binding lokalnego managed eksportu,
nie autoryzacja przeciw aktorowi mogącemu zmienić wszystkie trzy pliki.
Niezależny read-only review całego diffu trzech plików importera nie znalazł
Required/Blocker; potwierdził terminalny managed receipt i niezmieniony
fingerprint. Fragment zapisano w commicie
`51b37b119fdfdeacf83e3a0af97962422f170391`, rodzic
`d9afa91ed9968b93dfc16d9fb00d3a4948524a76`: generator, validator, regresje
i wyłącznie sekcja importu w przewodniku (4 pliki). Starsze RAM/UI/native
WIP oraz cały zależny plan/mapa pozostają poza commitem. Index po commicie
pusty, bez push/PR/merge; pełna integracja zadania pozostaje otwarta.
Nie ponowiono RAM, nie uruchomiono LLG/Relax. Starszy fixed RAM pozostaje
dowodem wyłącznie własnej kapsuły; zgoda użytkownika na naukę w RAM nie
kwalifikuje trwałego storage. Dalej odbiór terminalny właściwych buildów,
eksport R3, regeneracja i wszystkie niezamknięte bramki planu.

<!-- DOC-ANCHOR:antenna-managed-snapshot-openapi-export -->
### Checkpoint 2026-10-06 — eksport OpenAPI snapshotu: trasa wykonana, kontrakt R3 nadal otwarty

`scripts/export_runner_openapi.py::_validate_managed_build` ma jawną parę
`source_digest` / `native_snapshot_sha256`. Domyślny brak obu nadal wymaga
clean commit; explicit pair wymaga source mode snapshot i zgodności queue,
trusted context, full build receipt, całej kapsuły i native binding.
Niepełne, malformed lub błędne piny odrzucane przed alokacją evidence
i Dockerem. `_validate_openapi_document` wymaga dokładnego dirty bool
wykonanego pakietu; `_record_evidence` zachowuje ten stan, nie wpisuje clean.
Nowa recepta just dispatchuje tylko lokalny helper po ścisłej allowliście
argumentów. Composite commands i diagnostic-marker injection są odrzucane.

| Wejście operacyjne | Typ/domysł | Jednostka | Walidacja i znaczenie | Python/IR |
|---|---|---|---|---|
| `job_id` | wymagany string | $1$ | 32 lowercase hex; terminalny succeeded/0, ten sam worktree | brak zmiany |
| `expected_commit` | wymagany string | $1$ | 40 lowercase hex; bazowy HEAD identyczny w source/native | brak zmiany |
| `source_digest` | optional string, default `None` | $1$ | razem z drugim pinem; 64 lowercase hex i exact capsule/queue match | brak zmiany |
| `native_snapshot_sha256` | optional string, default `None` | $1$ | razem z pierwszym pinem; 64 lowercase hex i exact native match | brak zmiany |

RED: pięć nowych regresji przed implementacją (brak snapshot API),
GREEN: cały zestaw 32, 31 PASS / 1 SKIP Windows symlink 1314, exit 0.
Dry-run just potwierdził cytowanie zgodne z wrapperem; test dispatch
przy nonexistent job odmawia bez solvera i alokacji wyników.
Niezależny read-only review nie znalazł nowych Required/Blocker w tym
fragmencie; trzy dodatkowe próby uszkodzenia trusted context, native
receipt i bytes kapsuły zostały odrzucone przed alokacją evidence.

Realny eksport seq 33 `5d2e8e253c58405c9d44237cd9d2bce2` przez just:
`storage/runs/<worktree-id>/openapi-export/0c92c44b923440c285d5eb852b61bd78`.
Exit 0, cleanup/input hash verification true, raw OpenAPI 1562245 bytes,
source mode snapshot, worktree state dirty. Raw SHA-256
`06796b8b0a7d63c72febf7e5e4b902b6db5590bbde94107c92b18aae938e6416`,
receipt SHA-256 `cc6d69d49194c8d93d6f69a1de4e2488730df966640b1146eeb9797ec85c508a`,
proof SHA-256 `183001c2e899a34d2a98cbcb8e6e9edb6b108b70a6682322004e764d84e31da6`.
Pełne source/native piny seq 33 zapisane w sąsiednim checkpointcie R2.
To dowód nowej trasy narzędziowej, nie nauki ani schematu R3:
`AntennaQuadratureEvidenceRefResource` nie występuje w rzeczywistym raw.
Nie nadpisano generated JSON/TS starszym eksportem.

Spójny fragment eksportera zapisano w oddzielnym commicie
`d9afa91ed9968b93dfc16d9fb00d3a4948524a76`, rodzic
`202bbed4fff8c72099ef17489134bb1df911c090`: tylko exporter, jego regresje,
nowa recepta, jej wrapper i sekcja przewodnika. Starsze zmiany RAM/UI
i zależny WIP pozostają poza commitem; staged index po commicie pusty.
Bez push/PR/merge; integracja całego zadania pozostaje otwarta.
Buildy seq 33/34/35 nadal dotyczą własnych niezmiennych kapsuł z bazowym
HEAD 202bbed4fff8c72099ef17489134bb1df911c090, nie nowego commita.

Frontendowy domyślny importer nadal wymaga clean export. Najbliższy krok:
jawny snapshot import z potwierdzonym receiptem i raw-byte hash przed
normalizacją; następnie eksport i regeneracja z terminalnego seq 35.
Seq 34 running / seq 35 queued w aktualnym API. Brak nowego RAM/LLG/Relax,
brak zmian SessionStore i brak kompilowanych unit tests. R3 i pełny moduł
pozostają NOT VERIFIED.

### Checkpoint 2026-10-06 — R2: niezależny evidence reader, nie pełny odbiór naukowy

`tests/antenna/direct_quadrature_evidence.py::verify_direct_evidence` czyta
pełny wire 288+96N, bez importu Rust i source-test modeli. Sprawdza numeric
acceptance, exact options/caps, roots/leaves/refinements i sumy pracy,
ordered xyz/raw→per-A, current/scale/cert/summary. Fraction porównuje E+R
bez utraty sub-ULP R; tolerance odtworzone przez dokładne rational FMA i dwa
nested hypot, bez dopuszczania różnic ULP. Potencjalna różnica hypot między
Python a libm producenta jest odmową i wymaga qualification na runtime.

`read_solution_checked` wymaga v3 i evidence domyślnie. Jawny legacy v1/v2
opt-in nie dostaje globalnego certyfikatu. Trzy poziomy nie mogą mieszać
qualification i nadal używają identycznych fizycznych punktów oraz tych
samych progów L2/Linf. Manifest/plik są bounded; duplikaty JSON i złe paths
odrzucane. Niefinitywne normy/progi nie mogą spowodować false PASS.

RED 3 przed zmianą → aktualne 26 testów: 25 PASS / 1 symlink SKIP (Windows
1314), exit 0; CLI direct-script help PASS; niezależny review bez otwartych
Required/Blocker dla aktualnego readera i testów. Regresje synthetic, nie trzy
rzeczywiste native publikacje. Full R2 producer/input provenance, libm
parity, native scientific acceptance i reszta T00–T18 nadal required.
Te źródła powstały po capture seq 33/34/35; żaden z nich nie dowodzi R2.

Odebrano terminalny producent-only build `5d2e8e253c58405c9d44237cd9d2bce2`
seq 33: succeeded/0, pełny trusted receipt/artifact validator i cała kapsuła
7443 plików PASS. Source `e7ad2d0af36e146e448bf1146b8ea07017fff88f570eee98fe887a419e17441c`,
native `ed6129f2c9b11784b3ce2fbe947a225a2dbed2b4b6e8ddb28f26eebfd1e743ab`.
To odbiór kompilacji jego dokładnych źródeł, nie wykonanie nowego symbolu
ani qualification R1 adaptera/R3/R2. Bez nowego RAM, LLG/Relax i native tests.

### Checkpoint 2026-10-06 — R3: raw evidence i wspólna bramka publication/load/API

Źródłowo dodano `antenna_field_solution/direct_quadrature.rs`: format
`fem_direct_oersted_evidence.v1` (288 + 96 razy N bytes), pełne raw xyz/H/E/tau/R
i counts/options, measured current i normalization scale. Typy snapshotu oraz
bramka numerical acceptance są backend-neutral i wspólne z native adapterem.
Manifest ma explicit operator oraz thin evidence reference. Native producer
przekazuje własny retained snapshot, nie odtworzone H ani drugi solve.
Publisher sprawdza raw binding i pełny asset przed manifestem. Oba loaders
i API metadata/payload używają tej samej bramki; extra enclosing diagnostics
nie omijają evidence i nie są automatycznie błędem exact asset-set.

Zmiana odmawia direct v3 bez evidence, mixed/future records, złych raw→per-A,
summary signed-zero, leaf/work/counts i duplikatów nawet po rehash. Starsze
archiwa można rozpoznać, lecz brak operatora nie daje reusable certificate.
OE-F2 pozostaje odrębny; synthetic fixtures wcześniejszych testów plumbing
nie kwalifikują jego native wykonania. API reader ogranicza manifest do
16 MiB i sumę zakodowanych payloadów do 512 MiB; nie obcina wyników solvera.
Limit zakodowanych bytes nie jest limitem szczytowego RAM: dekodowane
rekordy i współrzędne wymagają dodatkowych alokacji.

Interpretowane checks runner/codec/API: 14 PASS, nie wykonanie Rust/native.
Zapisano 4 codec, 4 integration i 2 API bounds regressions Rust,
niekompilowane zgodnie z zakazem; obejmują 3 A, signed zero, oba loaders/
bundle extras i odmowy missing/mixed/future/duplicate po rehash. Syntax-only
parse siedmiu plików Rust PASS nie zastępuje type/borrow check ani buildu.
Niezależny read-only review runner/codec i API nie pozostawił Required/
Blocker w tym zakresie źródłowym. Nowy R3 nie znajduje się w kapsułach
seq 33 ani 34.
Zgłoszony dokładny R3 snapshot: job `feb603f43c5b4dfa98777f87d5422411`,
seq 35, `fem-cpu-release`, stan queued odczytany 2026-10-06 01:52 UTC.
Source digest `d2b97d400b9f60523de9a1f4db973352befa24be393a76bcd917d7ed74c0f97c`,
native snapshot `e0f81aa12a17686b2e47354d91d39f920bced75416b7fed5d66f39f3059faaf0`,
capture `28dbbaca58304a1189ef3503e8c10afe`; HEAD bazowy pozostaje
`202bbed4fff8c72099ef17489134bb1df911c090`. Ten dopisek powstał po capture
i nie należy do wskazanego digestu. Nie uruchomiono nowego RAM ani LLG/Relax.
Pełna weryfikacja kapsuły: 7448 plików, 78 jawnych untracked i 10 R3 source
pins PASS; jest to dowód tożsamości wejść, nie kompilacji ani wykonania.
OpenAPI/TS regeneration, full R2 external verifier, R3 build/runtime
i pełny moduł pozostają wymagane. Nie zamknięto T06/T09/T12
ani żadnej broad qualification na podstawie samych źródeł.

### Checkpoint 2026-10-06 — Duffy-v2 i pinowanie wejścia: korekta źródłowa, nie nowy runtime

Lokalna data 2026-10-06; aktualizacja 2026-10-05 22:17 UTC. HEAD nadal
`202bbed4fff8c72099ef17489134bb1df911c090`, zależny WIP zachowany.
Zgodnie z science contract najpierw wyprowadzono w 0950 mapę Duffy,
Jacobian i regularną całkę ze znakiem target-source; komplet SI, parametrów,
Python/IR wpływu, źródeł i ograniczeń jest w anchorach
`antenna-duffy-singular-transformation` oraz
`antenna-global-target-quadrature-design`.

Naprawiono trzy rzeczywiste błędy gałęzi wewnątrz przewodnika:
MFEM segment już ma punkty/wagi na [0,1], zatem nie przekształcamy ich
drugi raz; znak jądra jest ujemny dla source=target+xi*ray; po skróceniu
osobliwości nie pozostają xi² ani .125 w wadze. Nie zmieniono prądu RT0,
ordinary outside-source quadrature ani tolerancji. Ta korekta **nie jest
ustaloną przyczyną sixth RAM FAIL**, którego cele leżą poza przewodnikiem.

Aktualny operator to `fem_oersted_direct_tetra_quadrature.v2` w native i IR.
ABI JSON ma zgodną wersję; outer/field framing pozostaje v1. Owned Rust
inspection dekoduje i zachowuje literalne archiwalne v1 oraz aktualne v2,
lecz request-bound gate wymaga bieżącego operatora. Partial Python reader
również zachowuje wersję i odmawia nieznanej; nie promuje qualification.
Resolved preset `external_lead_direct_defaults.unqualified.v2` jest obecny
w solver/sampling pinie; adapter wymaga bieżącego presetu i legacy floor 1.
Stare wejście wymaga ponownej materializacji, a nie reinterpretacji cache.
Dokładne historyczne bytes, hashe, receipts i sixth diagnostic pozostawiono.

Interpretowane regresje: początkowe RED 4 FAIL/6 PASS odtwarzają błędy
transformacji i brak wersjonowania; po poprawce 33 PASS Duffy/association/
driver. Oddzielny source RED presetu/pinu 1 FAIL, następnie cały Duffy
11 PASS. Łącznie 34 różne przypadki PASS. W pierwszym łącznym wywołaniu
25 PASS/8 setup errors wynikało z niedostępnego pytest temp; po poprawnym
D-storage basetemp 33 PASS bez zmiany asercji. Żadnych kompilowanych unit
tests. Niezależny source review Duffy/codec PASS; finalny review pinowania
zapisany osobno w evidence. Focused science validator 0. To dowody źródłowe
i algebraiczne, **nie wykonanie C++/MFEM ani odbiór H**.

Globalną adaptację zaprojektowano dla sumy finalnych liści targetu:
suma norm low/high, tolerancja od sumy H, bez dimensional floor, refinowanie
największego estymatora i zastępowanie rodzica sumą dzieci. Limity realnych
ewaluacji/pamięci, cancellation/roundoff i jawne failures wymagają jeszcze
wdrożenia wraz z następną wersją operatora i retained diagnostics.
Duffy-v2 nadal zachowuje lokalny legacy budżet; nie udaje globalnego certyfikatu.

Następnie: wdrożyć pełny T06 target-global budget, zachować odczyt wersji
historycznych, wykonać interpretowane kontrakty i review, a potem jeden
immutable build przez istniejącą kolejkę/container-backed just. Dopiero
zgodny terminalny pakiet uruchomić w **zatwierdzonej tymczasowej sesji RAM**,
z wynikami wyłącznie w canonical storage D:. Bez LLG/Relax, bez trwałego
SessionStore i bez nowych targetów/parametrów fixture udających ten sam test.
Nie wykonać ręcznego host builda ani nie obniżyć oracle. Osobny inside/
near/face/edge runtime oracle jest dalszą bramką, nie wynikiem obecnej zgody
na fixed RAM fixture. Pełne T00–T18 oraz integracja pozostają otwarte.

### Checkpoint 2026-10-05 — szósty test RAM: RT0 przyjęte, dokładność H odrzucona

Pełny immutable build `76c2851f50454866aba697c672b30b56` zakończył się
terminalnym `succeeded`, exit 0; native-build 607514.403 ms,
frontend-dependencies 558244.765 ms i frontend-build 237952.788 ms, wszystkie
exit 0. Receipt SHA-256
`508751246cf4426aab87745c14007c7869f0995cc53cfba59a0acf30cd9d3cbf`.
Pełne trusted/capsule/source/artifact validators oraz hashe trzech
niezmienionych wejść fixture PASS. Kapsuła zawiera wspólny affine RT0;
hostowe checkery i poprawka parsera startup powstały po jej capture.

Zatwierdzony run `444b0769d1524dc6b6d4899d8ef2a941`, kontener
`7aea12e195e372f266e39bbd1b10c210861f3d8deffb88e37b10e57c1c07480a`,
start `2026-10-05T21:40:23.832724642Z`, koniec
`2026-10-05T21:40:27.275967437Z`: solver/container exit 0, OOM false,
Docker Error pusty, izolacja PASS. Jeden `antenna_field_solve`, zero kroków
LLG, bez Relax, sieci i portów; sesja wyłącznie w tmpfs. Eksport zachowany
pod `D:/git/fullmag/storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/managed-antenna-ram-cpu/runs/444b0769d1524dc6b6d4899d8ef2a941`.
Log SHA-256 `3990420467daee077c169d60a5886b31cef23b6443946833bd044a17db1e9e22`.

Pierwszy observe odrzucił nowy kanoniczny nagłówek `[fullmag] version: ... |
build: ...`, mimo zgodnych pełnych identyfikatorów. Naprawiono wyłącznie
hostowy `verify_saved_fem_archive_roundtrip.py::check_stamp`: oba formaty,
pełne SHA i rzeczywisty bool dirty; mieszane duplikaty nadal odmawiają.
Regresja RED 4/28 → GREEN 28/28; RAM/browser razem 88 PASS oraz 6 istniejących
archive identity PASS, niezależny source review PASS. Poprawka parsera i
28 nowych regresji zapisane osobno w checkpoint commit
`202bbed4fff8c72099ef17489134bb1df911c090`; pozostały zależny WIP nie został
do niego dołączony. To nie commit kwalifikacji naukowej ani integracja.
Ponowny observe tego
samego wyniku (bez nowego solvera) przeszedł do
`solver_succeeded_comparison_pending`. Stary `error` w receipt jest zapisem
tej pierwszej odmowy parsera, nie nowym błędem solvera.

Niezależna geometria RT0: 108 ścian, 36 elementów, maksymalny błąd momentu
`2.220446049250313e-16 A`, suma outward w każdym elemencie `0 A`.
Exact association 16 V i 4 xyz/H oraz nested SHA PASS. Oracle V przechodzi
przed sprawdzeniem H. Końcowy driver V/RT0/H ma **exit 1**, nie PASS:

| Punkt [m] | Norma błędu H [A/m] | Próg H [A/m] | Błąd / próg | Wynik |
|---|---:|---:|---:|---|
| (0,0,2) | 4.551868310297808e-7 | 6.131203777591822e-8 | 7.424102142769856 | FAIL |
| (1,0,2) | 4.7480923849064843e-7 | 6.131203777591822e-8 | 7.7441438209242035 | FAIL |
| (0,1,2) | 8.365609367236374e-8 | 7.126402117242230e-8 | 1.1738896051060463 | FAIL |
| (0,0,3) | 1.3075838894083228e-9 | 2.913599577674578e-8 | 0.04487864082036765 | PASS |

Native field record: order 4, depth 6, atol `1e-9 A/m`, rtol `1e-5`,
fixed floor `1 A/m`; 144 source-target pairs, **zero refined pairs**,
zero unconverged pairs, maximum pair estimator `3.617581831753044e-6 A/m`.
Zgodnie z istniejącym równaniem `antenna-external-quadrature-local-policy`
lokalny próg wynosi co najmniej `1.0001e-5 A/m`; taka akceptacja nie wymaga
globalnej dokładności oracle. Jest to potwierdzona rozbieżność polityk,
nie dowód błędu czynnika normalizacji RT0 ani pełny bound błędu H.
Odpowiedni owner: `direct_tetra_quadrature.cpp::integrate_adaptive`;
niezależny oracle: `antenna_current_source_oracle.py::compare_fixture`.

Następny krok: T06 — usunięcie arbitralnego dimensional floor i jawny
budżet błędu dla sumy źródeł oraz adaptacyjnych dzieci, zgodny z żądaną
dokładnością obserwabli; zaktualizować wersjonowaną politykę/record/API tam,
gdzie zmienia się semantyka. Nie zwiększać progów oracle ani nie dobierać
stałej tylko pod ten wynik. Potem source/model regression, review, nowy
immutable managed build i ten sam zatwierdzony RAM fixture. Błąd estymatora
low/high nie jest rygorystycznym certyfikatem rzeczywistego błędu; potrzebne
są osobne przebiegi zbieżności. Pełne V/RT0/H, H-per-A/reuse/LLG/FFT i
trwałość nadal **NOT VERIFIED**; żadna pozycja T00–T18 nie została przez
sam ten test zamknięta.

### Checkpoint 2026-10-05 — wspólna stabilna rekonstrukcja RT0 w źródłach

Aktualizacja hostowej bramki nauki w czasie aktywnego buildu `76c2851f...`:
niezależny audyt wykazał, że dotychczasowy oracle porównuje derived sidecar
V/H, ale nie wiąże ich ponownie z retained charge/field. Zmiana embedded
`potential_v` do 123 V albo przewodności do 123 S/m i przeliczenie nested SHA
nadal przechodziły samą kontrolę RT0. Jest to dowód wąskiego zakresu checkera,
nie dowód błędu natywnego publishera (jego canonical loader ma te bramki).

Dodano `compare_bundle_observables`: exact authored device IDs/V, ordered
xyz/H oraz manifest/nested charge/source/field digest association.
Wszystkie kopie pochodzą z tego samego wyniku, więc bramka nie używa
tolerancji. `compare` wymaga teraz RT0 i tego związania przed oracle PASS.
Nowe testy rehashed embedded V/H/xyz, links/count/framing/manifest/IDs/-0:
RED 12 → GREEN 12; wraz z właściwymi konsumentami **39 PASS**, exit 0;
niezależny source review PASS. Kod hostowego supportu powstał po capture;
nie zmieniono kodu native ani wejść naukowego fixture, nie zlecono drugiego
buildu. Przewodność, pełny canonical codec/input pins i error budget nadal
nie są niezależnie kwalifikowane przez ten support. Wszystkie globalne
qualification flags pozostają false. Właściciel:
[0950 — observable association](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md#antenna-current-source-fixture-observable-association).

Punkt wznowienia po piątej odmowie RAM: wdrożono prywatny FEM CPU owner
`transport/affine_rt0_element.{hpp,cpp}`. Wspólna baza geometryczna zasila
weighted mass/load obu KKT realizacji, pełny czterowyrazowy certyfikat
momentów ścian oraz prąd w kwadraturze H. Exact cold arytmetyka binary64
geometrii nie zeruje małych momentów przez epsilon. Point evaluator nie
alokuje ani nie pobiera DOF. Generic normalizacja 1/2 i konwersja fizycznych
momentów pozostają jawne; nie zmieniono tolerancji ani publicznego modelu.

Niezależny source review wykrył powtórny cold preflight w `ProjectField`:
poprawiono go na jeden prepared source snapshot wspólny dla wszystkich
punktów i trzech składowych projekcji H1. Dodano odmowę pustego FESpace
przed dereferencją, field evaluation bez frozen coefficients oraz underflow
przy konwersji niezerowego point value do double zera.

Interpretowane regresje: **25 PASS**, exit 0 (16 nowej wspólnej rekonstrukcji,
7 wcześniejszej normalizacji, 2 diagnostyki). Fraction oracle obejmuje
skew/scale/translation, 24 permutacje, wszystkie cztery basis moments,
signed/zero/tiny currents, niezależną Piolę obu znaków determinant i
skalowanie mass/load. Jedna początkowa awaria nowego point oracle wynikała
z mieszania Fraction z float vertices; jawne Fraction wejścia przywróciły
dokładny model. Nie kompilowano native unit tests.

Ten dowód nie wykonuje C++/MFEM i nie kwalifikuje rzeczywistych signed map
odwróconych elementów. Native build i V/RT0/H pozostają **NOT VERIFIED**.
Właściciel równań, jednostek, źródeł i ograniczeń:
[0950 — wspólna rekonstrukcja](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md#antenna-rt0-stable-shared-reconstruction).
Następnie immutable managed build i tylko zatwierdzony test naukowy w RAM;
full closure, convergency/error budget, standalone, reuse/LLG/FFT/UI i
trwały SessionStore nadal otwarte, bez promocji T00–T18.

### Checkpoint 2026-10-05 — piąty test RAM: ilościowa odmowa ciągłości RT0

Build diagnostyczny `a88fb51824264026a7fca17d89f1e30f` zakończył się
terminalnym `succeeded`, exit 0. Wszystkie trzy etapy exit 0;
receipt SHA-256 `e23d4bb199e03a87753abcc9ed2a3a669837ee3c5e87db750119fca0e839fb25`.
Pełne validators builda, capsule/source i hashów przeszły zarówno przed
startem, jak i przy observe. Zgodnie z autoryzacją wykonano **tylko RAM
scientific fixture**, bez LLG/Relax, sieci, portów i trwałej sesji.

Run `fdf15e1ac6a347009b9e25a50d151c8d`, kontener
`cb53cd1cb5b6879db809cc2035e3c05cd2ee3a8b935c904d2d3a37501a05bcf6`,
start `2026-10-05T20:29:44.443729992Z`, koniec
`2026-10-05T20:29:47.780546695Z`: exit 1, OOM false, izolacja PASS.
Eksport zachowano pod
`D:/git/fullmag/storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/managed-antenna-ram-cpu/runs/fdf15e1ac6a347009b9e25a50d151c8d`.
Receipt SHA-256 `212955456bede80db489484210f0c4c5853463bfc0b4311dd180c932cbcfacad`;
log SHA-256 `990735bae04d01bb8fa268c3257544c4b3c09dea964f9692bbe8c68b2f979956`.
W result bundle jest tylko `output-storage.json` ze stanem `running`:
to niedokończony eksport po odmowie, nie naukowy wynik ani zakończony stage.

Rzeczywisty error podaje ścianę `[9,10,15]`, leksykograficzne outward
momenty `1.1102230246251565e-16 A` i `-1.2490009027033011e-16 A` oraz
signed MFEM Elem1-minus-Elem2 jump `-1.3877787807814457e-17 A`.
ABI `error_message[256]` obciął dalsze pola komunikatu. Z tych momentów
i niezmienionego predykatu odtworzono scale `2.3592239273284576e-16 A`
i tolerance około `1.0000000235922393e-18 A`, przekroczenie około 13,9 razy.
To **odtworzone liczby**, nie brakujące pomiary wyczytane z logu.
Brak owned coefficients oraz pełnych pól J nie pozwala jeszcze przypisać
całego mechanizmu do inverse centroid, vector-first cancellation lub
floating-point Ti. Nie zerować małego rzeczywistego prądu na tej podstawie.

Źródłowa normalizacja opisana poniżej nie była w tej kapsule.
Niezależny read-only review pomiaru wskazał ważną granicę: geometryczny
certyfikat matematycznego RT0 nie dowodzi literalnego rounded
`GetVectorValue`, używanego także przez Oersted. Podmiana tylko certyfikatu
może ukryć rozbieżność źródła H. Przygotować wspólny stabilny evaluator
lub jawny basis/reference i discrepancy/error budget, z wszystkimi signed
local coefficients, actual geometry, mapowaniem/orientacją obu stron oraz
bounded arytmetyką. Basis-first i `long double` same nie gwarantują progu
dla arbitrary skew/scale. Nie zmieniać gate, nie kopiować shared face DOF
jako niezależnego dowodu i nie skalować końcowego H posthoc.
Pełny właściciel wyprowadzenia i stanu:
[0950 — normalizacja i granica pomiaru](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md#antenna-rt0-native-normalization-audit).

Następnie nowy immutable snapshot/build poprawionego operatora i ten sam
zatwierdzony RAM fixture. V/RT0/H comparison dopiero po zaakceptowanym
solver success. Nie zlecono jeszcze tego buildu; nie usunięto kontenerów
ani dowodów. T00–T18, full closure, convergency/error budget, true standalone,
reuse/LLG/FFT/UI i trwałość sesji pozostają otwarte.

### Checkpoint 2026-10-05 — źródłowa korekta współrzędnych RT0

Po dowodzie opisanym poniżej wdrożono minimalną korektę we wspólnym
`conservative_current_view.cpp::solve_weighted_rt0_projection`:
inverse generic face moment 2, skalowanie test/trial basis przed assembly
mass/load i konwersję physical flux coordinates do raw MFEM coefficients
przy zapisie GridFunction, po istniejących residual/energy gates.
Typed preflight wymaga generic `RT_TetrahedronElement`, order 1 i 4 DOF.
Ograniczenia integer ±1, RHS H1, rank ledger oraz tolerancje są niezmienione.
Shared assembly obejmuje dense i sparse realizacje; nie przeniesiono solve
do runnera ani nie dodano GPU/Context state.

Nowa `scripts/test_antenna_rt0_normalization_source.py`: RED 2 failures / 5 PASS
→ GREEN 7 PASS. Wraz z source-only diagnostyką gate: **9 PASS**, exit 0.
Dwie kontrole sprawdzają źródłowy assembly i późną konwersję; pięć exact
Fraction przypadków niezależnego dwuwspółczynnikowego modelu obejmuje signed,
zero i mały prąd, constrained objective oraz błędne posthoc field doubling.
Nie uruchomiono MFEM ani C++ unit tests. Review nowych linii C++ i testów:
source PASS w zakresie generic v4.7 affine tet4, bez runtime qualification.
Scoped diff PASS. Pełna nota i obie source maps pozostają właścicielem wyprowadzenia.

Korekta powstała **po capture** aktywnego buildu
`a88fb51824264026a7fca17d89f1e30f`: tamte źródła/pakiet obejmują tylko
diagnostykę wcześniejszej odmowy, nie nowe skalowanie. W chwili tego
checkpointu etapy native build i frontend dependencies miały exit 0,
a frontend build trwał. Późniejszy terminalny odbiór i piąty test RAM
opisano powyżej. Nie zlecono równoległej ciężkiej kompilacji.
Następnie zamknąć przyczynę błędu niezależnego physical measurement i
przypiąć aktualną korektę do nowego snapshotu/managed buildu. Dotychczasowe
V/RT0/H, closure, convergency/error budget, reuse/LLG/FFT i trwałość pozostają
NOT VERIFIED; pełny zakres T00–T18 nie zmienia się.

### Checkpoint 2026-10-05 — oddzielenie normalizacji RT0 od błędu pomiaru

W czasie aktywnego buildu diagnostyki `a88fb51824264026a7fca17d89f1e30f`
wykonano niezależny read-only audyt normalizacji. Primary MFEM v4.7
`RT_FECollection(0,3)` wybiera generic `RT_TetrahedronElement(0)`:
integralny moment lokalnej bazy to **1/2**, nie 1 jak w osobnym fixed
`RT0TetFiniteElement`. Piola zachowuje moment. Ówczesny
`conservative_current_view.cpp::solve_weighted_rt0_projection` używał
surowej bazy, terminalowego RHS H1 i samych znaków ±1, a wynik wpisywał
bez konwersji do GridFunction. Dla tej normalizacji terminalowe
ograniczenie oznacza połowę rzeczywistego prądu H1. Jednorodne div/pair
rows nadal opisują poprawne zera. Review źródłowy potwierdził rozróżnienie;
nie wykonano compiled tests ani innego solve.

Pełne wyprowadzenie, jednostki, primary źródła i dwa warianty korekty:
[0950 — audyt normalizacji](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md#antenna-rt0-native-normalization-audit).
Preferowany wariant: fizyczne flux coordinates w KKT, skalowanie mass/load
i konwersja do surowych owned coefficients przy zapisie. Zachowuje
integer rank ledger i fizyczny RHS. Alternatywa: fizyczne weights we
wszystkich constraint rows z jawną mapą ledgeru. Nie naprawiać przez
samo podwojenie końcowego H ani zmianę tolerancji. **W chwili tego audytu
korekty solvera jeszcze nie wdrożono; późniejszy stan opisano powyżej.**

Mały zatwierdzony odczyt trzech plików prefiksu w dokładnym workerze
`d0a687b1a111c408171edb24eb6626d31b9d868b8aeb1a0cb00e6c9366e8885e`
potwierdził metadata `/opt/fullmag-deps`: `PACKAGE_VERSION=4.7.0`,
`MFEM_VERSION=40700`, `MFEM_VERSION_STRING=4.7.0`.
SHA-256 version config:
`91539f617ab7f608fe17d7626ce5e38022645d53f38d6ce9d47df56f9170950d`;
generated header:
`9560f23c4cebf47e6bd6a3dba51ba78d790da2c3518c963359ba52a5f30e97cb`.
To odczyt konfiguracji image/prefiksu, nie dynamiczny pomiar bazy
załadowanej biblioteki; receipts nadal nie mają pełnej dependency identity.

Osobna, interpretowana demonstracja arytmetyki binary64 na jednostkowym
tetraedrze z fizycznie unit-flux bazą i współczynnikami `(0,0.1,0.2,-0.3)`:
exact rational moment ściany przeciwległej do pierwszego wierzchołka wynosi
0 A, podczas gdy vector-first centroid dot dał
`-2.7755575615628914e-17 A`. Basis-first vertex integration dał 0 A.
Referencja używała dokładnych wartości binary64 przez `Fraction(float)`;
nie była to MFEM GridFunction ani rekonstrukcja rzeczywistego rozwiązania.
Przykład dowodzi możliwości utraty dokładności pomiaru, **nie przyczyny
odmowy aktualnego native solve** ani gwarancji dokładności na arbitrary skew.

Następny krok pozostaje niezmieniony: odebrać terminalny pełny build,
wykonać dokładnie zatwierdzony test RAM, odczytać konkretne liczby jump,
a następnie naprawić i osobno zweryfikować normalizację oraz niezależny
physical measurement. Dokumentacja powstała po capture; nie należy
przypisywać jej wcześniejszej kapsule. V/RT0/H, trwałość i reuse/LLG/FFT
pozostają NOT VERIFIED.

### Checkpoint 2026-10-05 — czwarty test RAM i diagnostyka odmowy RT0

Build `7c4ef0fe6ed745b682ea2229024552a8` zakończył się terminalnym
`succeeded`, exit 0. Wszystkie trzy fazy mają exit 0; pełne validators
pakietu i kapsuły przeszły przed startem oraz podczas obserwacji testu.
Receipt SHA-256 `522f5d7bfc119c8040bcd26866a61c148ad4a165fae51529f0dc25e50c723958`
obejmuje 126 artefaktów. Wcześniejsze opisy `running` są historyczne.

Ten sam zatwierdzony fixture, wyłącznie tmpfs, wykonano w runie
`69e3ae4f52b64b5e951baa2e213e793b`, kontener
`24c7764024705ee4698c6bc8b428113cbb74ab6a531c6303e9356bde6bac9c3b`.
Solver exit 1, OOM false: `terminal RT0 projection failed its local interior continuity gate`.
Poprzednia odmowa Boost nie wystąpiła, lecz nie ma zaakceptowanego V/RT0/H.
Dokładny authored stage `inspect_antenna` ma `status=failed`, `outputs=[]`.
Log, kontener, stage record i receipt zachowano pod storage. Brak Relax/Run.

Niezależny przegląd MFEM v4.7 oraz dwóch pomiarów w
`conservative_current_view.cpp::evaluate_field_at` nie dowodzi błędu orientacji.
Hipoteza roundoff przy niemal zerowym normalnym prądzie pozostaje hipotezą;
obecny log nie podaje wartości. Nie wolno zastąpić bramki wcześniejszym
epsilon-floor ani zwiększyć tolerancji bez rozstrzygnięcia pomiaru.

Minimalna diagnostyka w
`conservative_current_view.cpp::TerminalConstrainedRt0Projection::Ptr project_terminal_constrained_rt0_owned`
formuje komunikat **tylko po odmowie**, z 17 cyframi: stable face IDs,
oba lexicographic-element outward moments, signed canonical jump w kolejności
MFEM Elem1−Elem2, scale oraz tolerance. Predykat i próg pozostają identyczne.
Brak nowych pól canonical bundle, `ProblemIR`, publicznego API i normalnych logów.
Pełne wektory J nie są tu zachowane; te liczby odróżnią mały moment od dużej
nieciągłości, lecz same nie dowodzą mechanizmu cancellation.

`scripts/test_antenna_rt0_failure_diagnostics_source.py`: source-only RED
2 failures → GREEN 2 PASS, exit 0. Regresje sprawdzają niezmieniony predykat,
failure-only formatting i jednoznaczne etykiety, **nie wykonują C++ ani fizyki**.
Review: Required o niejednoznacznym first/second usunięto przez etykiety
`lex_first_outward_a`, `lex_second_outward_a` i jawny porządek jump;
po tej korekcie zakres diagnostyki PASS. Scoped diff PASS.

Nowy immutable snapshot zgłoszono w pojedynczej kolejce:
`a88fb51824264026a7fca17d89f1e30f`, profil `fem-cpu-release`, request key
`antenna-continuity-diagnostics-20261005-0592aad1`, 65 jawnych untracked inputs.
Edycje źródeł były wstrzymane na capture. Kapsuła
`6751a00dc0834bf7a866f8886fffda53`, baza `0592aad17a7620966a5de2aea93deafed945cf91`,
source digest `c41da907c891c2f8eed6ce54689d0d4f9a88566abf6fc0e50c66b1934f3690b3`,
native snapshot `3ae365b061f22616f1f1ecfbfbcead47ea1d478a14f40459973d9545123debe5`.
Hash kapsuły dokładnie obejmuje korektę diagnostyczną CPP
`38cab9aa0019318e9672daaa7f4cc09dbca2ecde0db19cb4fa7b804eee500e44`
oraz regresję `9616774535f9c4806555675255545b328852f6c00caca0cdbd5a943efb1b6422`.
Stan API o 19:46 UTC: `running`, terminal exit null; nie wynik naukowy.
Ta dopiska powstała po capture i nie jest częścią powyższego digestu.

Następny krok: pełny terminalny receipt oraz validator nowego buildu,
ten sam test RAM, odczyt rzeczywistej ściany i liczb, dopiero potem wybór
stabilniejszej niezależnej integracji lub innej poprawki przyczyny.
Nie dodano fallbacku, zerowania małych momentów ani osłabienia bramki.
Wszystkie kwalifikacje T05/T06/T12/T18, trwałości i reuse/LLG/FFT pozostają otwarte.

### Checkpoint 2026-10-05 — lokalny commit normalizacji pivotów

Commit `0592aad17a7620966a5de2aea93deafed945cf91` zapisuje wyłącznie
`conservative_constraint_rank.cpp` i jego regresje źródłowe, 51 dodanych,
2 usunięte linie. Source review PASS, scoped diff PASS, faza managed native
exit 0; C++ unit tests nie były kompilowane. Nie zamyka odbioru naukowego
ani pełnego buildu. Snapshot aktywnego joba nadal ma bazę
`35ae2d130563faae2c78331a04aa6d625b5407bd`; commit nie zmienił kapsuły,
digestów ani pakietu. Pozostały zależny WIP zachowano bez stage'owania.

### Checkpoint 2026-10-05 — niezależna kontrola RT0 przed porównaniem RAM

Porównanie `scripts/compare_managed_antenna_ram.py::compare` wymaga teraz
kontroli wszystkich 108 momentów ścian i bilansu 36 tetraedrów tego samego
przykładu, oprócz V/H. `scripts/antenna_rt0_fixture_check.py::compare_rt0_fixture`
wyznacza wzorcowe momenty z geometrii i jednolitej gęstości prądu; równanie,
jednostki i ograniczenia opisuje nota 0950, sekcja
`antenna-current-source-fixture-rt0-check`. Porównuje je z iloczynem
rzeczywistego współczynnika RT0 i zachowanej natywnej wagi fizycznej.
Ujemny signed DOF koduje indeks, nie dodatkowy znak momentu. Bilans elementu
jest niezależnie sumowany z orientacją z geometrii, a nie kopiowany z ledgera.

Interpretowane regresje: **44 PASS** (18 RT0, 8 orkiestracji, 18 odczytu),
exit 0. Regresja orkiestracji najpierw była RED: odmowa RT0 nie zatrzymywała
PASS. Po wpięciu bramki jest GREEN. Pierwszy łączny test ujawnił wyłącznie
limit długości Windows `PYTEST_CURRENT_TEST`; krótkie jawne identyfikatory
przypadków naprawiły harness bez zmiany danych, asercji ani tolerancji.
Niezależny review pięciu plików: PASS, bez Required/Blocker.

To narzędzie hostowego odczytu **częściowego** rekordu o limicie 2 MiB,
nie pełny natywny canonical decoder, certyfikacja normalizacji MFEM ani
walidacja wszystkich pinów i ledgerów. Testy używają syntetycznych partial
records, nie zaakceptowanego eksportu solvera. Zachowane native weights
nie zostały niezależnie certyfikowane. Wszystkie flagi kwalifikacji fizyki,
trwałości oraz reuse/LLG/FFT pozostają false. Nowe narzędzie powstało po
capture `56c463e4f35e4a70b63942453ce3ae84`; nie podmienia źródeł pakietu.

Build `7c4ef0fe6ed745b682ea2229024552a8` ma zakończony `native-build`
z exit 0 i czasem 803622.91 ms, lecz pełny job nadal wykonuje
`frontend-dependencies`. To obserwacja fazy, nie terminalny sukces buildu
ani wynik naukowy. Po pełnym odbiorze należy uruchomić zatwierdzony fixture
RAM i wymagać wspólnego V/RT0/H PASS. T05/T06/T12/T18 pozostają otwarte.

### Checkpoint 2026-10-05 — rzeczywisty RAM solve i ujemny pivot Bareissa

Pełny build `db180d706d8544ec9325d24be260a8fc` zakończony terminalnym
`succeeded`, exit 0. Przed startem oraz podczas obserwacji testu RAM przeszły
pełne managed build/source validators; receipt SHA-256
`4502d329bd378ac6472480865f3e2365c3fbf6237263c3db4cae74f84c822988`
obejmuje 126 artefaktów. Historyczne obserwacje `running` w poniższym
checkpointcie opisują wcześniejsze chwile, nie stan końcowy.

Zatwierdzony test naukowy z sesją wyłącznie w tmpfs wykonano w runie
`6322765a54b94befa88d86f4ed9e1634`, kontener
`ad927522f5e1b5be83ade61c93874ad8f9058facf756cc4106b602e50d27c28d`.
Kapsuła i pakiet pozostały niezmienne: baza
`5999324c59dd9398adc3bfbbb61557b17a7199d9`, source digest
`59c1befb1648d9f42aa8550bf02bc4acb2669accd3611e483e158cd8b4c74c91`,
native snapshot `fd00dd7e67bf574af0e9e66d587b2d7f25ed492d17c2fa68e98c84212733c4e6`.
Eksport konfiguracji i wejście do natywnego solve doszły do skutku;
solver zakończył się exit 1, OOM false, z komunikatem
`accepted external lead failed (-2): bad rational: non-zero singular denominator`.
Dokładny rekord `stage-000/antenna_external_lead_stage_output.v1.json`
ma `stage_id=inspect_antenna`, `status=failed`, `outputs=[]`.
Nie ma zaakceptowanego wyniku V/RT0/H ani porównania z oracle.
Ostrzeżenie początkowego torque nie oznacza wykonania LLG; skrypt zawiera
wyłącznie jeden `antenna_field_solve`, bez Relax/Run.

Źródłem awarii jest zgodność arytmetyki dokładnej z zainstalowanym Boost 1.74.
Nagłówki odczytane z dokładnego zakończonego workera potwierdzają, że
`boost::rational<cpp_int>::normalize` sprawdza ujemny mianownik przed
normalizacją znaku, przy `numeric_limits<cpp_int>::max()` równym zeru
dla typu nieograniczonego. Ujemny pivot Bareissa jest legalny i nie oznacza
singularności fizycznego układu. Zob. [źródło Boost 1.74](https://github.com/boostorg/rational/blob/boost-1.74.0/include/boost/rational.hpp).

Minimalna korekta w
`backends/fem/cpu/mfem/transport/conservative_constraint_rank.cpp::divide_rational_integer`
przenosi znak z ujemnego mianownika przez równoczesną negację obu argumentów
przed konstruktorem rational. Dokładny iloraz, rank, orientacje i bramki
residuum pozostają niezmienione; dwie negacje są rozliczone w work budget.
Nie zniesiono odmowy zerowego pivota ani żadnej bramki kwalifikacji.
Źródło SHA-256 `b09595e88f5bb9d76addad0b44256fee7fcc5a780e4234b7e9ee8e025cf277ba`.

W `backends/fem/tests/conservative_constraint_rank_contract.cpp`
dodano `::negative_intermediate_pivots_preserve_independent_rank` oraz
`::negative_final_pivots_preserve_signed_physical_residuals`: niezerowy RHS
dzielony przez ujemny pośredni pivot, końcowe residua ±1 A, inkluzywny
gate 1 A i odmowa przy domyślnym progu ze znakiem oraz ID wiersza.
Testy C++ **nie były kompilowane ani wykonywane** zgodnie z obowiązującym
zakazem. Niezależny przegląd dokładnej poprawki: PASS, bez Required/Blocker;
scoped `git diff --check`: PASS. To dowody źródłowe, nie runtime qualification.

Nowy pełny build w pojedynczej kolejce:
`7c4ef0fe6ed745b682ea2229024552a8`, profil `fem-cpu-release`,
request key `antenna-negative-pivot-20261005-35ae2d13-2036`.
Nieśledzone wejścia wskazano jawnie (62 pliki), edycje wstrzymano na capture.
Kapsuła `56c463e4f35e4a70b63942453ce3ae84`, baza
`35ae2d130563faae2c78331a04aa6d625b5407bd`, source digest
`4e8bedfbb99f2b37a0ba70352c002700f3bc6fc6de9fcb0b1070d0efc25c5803`,
native snapshot `dbdff7ae0e32ba9772db089323ef9823648dc57392ac5c11ac6f4c8b0233e70e`.
Nie podmieniono poprzedniego pakietu ani kapsuły. Ten checkpoint dokumentacyjny
powstał po capture i nie jest częścią tej tożsamości buildu.
Po terminalnym sukcesie i pełnym validatorze należy ponowić **ten sam** test
RAM, a dopiero po sukcesie solvera wykonać dokładne porównanie V/H.

Receipts, pełny log, failed stage record i hashe nagłówków zachowano pod
kanonicznym storage w `tmp/<worktree-id>/current-source-oracle/ram-runtime-and-helper-verification-20261005.json`.
Stan native V/RT0/H, closure/convergence/error certificate, trwałości sesji,
reuse/LLG/FFT i kwalifikacji czterech realizacji nadal **NOT VERIFIED**.
T05/T06/T12/T18 pozostają otwarte; nie zmieniono kontraktu modeli ani 9p guard.

### Checkpoint 2026-10-05 — powiązanie porównania V/H z konkretnym runem

Dodano `scripts/compare_managed_antenna_ram.py::compare`: po ponownej
pełnej kontroli `run_managed_antenna_ram.py::observe` i managed build validatora
przyjmuje tylko `solver_succeeded_comparison_pending`. W osobnym izolowanym
procesie Pythona odtwarza wejście z staged skryptu tego runu oraz publicznego
DSL **dokładnej zweryfikowanej kapsuły**, nie z bieżącego worktree.
`::reconstruct_inputs` sprawdza rzeczywistą ścieżkę importu Fullmaga,
jeden etap `antenna_field_solve`, dwa oryginalne assety i cardinality
current/port. Nie wykonuje solve, Relax ani Run. Jest to rekonstrukcja
na hoście, **nie** zrzut rzeczywiście wykonanego native `ProblemIR`.

Odczyt wskazuje wyłącznie
`export/result.zarr/artifacts/antenna/external_lead_stage_outputs/stage-000/antenna_external_lead_stage_output.v1.json`
w zadanym runie. Nie szuka „latest” ani dowolnego manifestu. Integralność
record/manifest/pięciu payloadów sprawdza `antenna_inspection_export.py::read_inspection`;
actual stable IDs, V, positions i H przekazuje do
`antenna_current_source_oracle.py::compare_fixture`. Tolerancje wynoszą
$10^{-8}\,\mathrm{V}$, $10^{-8}\,\mathrm{A\,m^{-1}}$ oraz względne $10^{-6}$.
Wynik JSON zawiera tożsamość runu, buildu, kapsuły, logu i rewizji,
pełne próbki oraz zastosowane tolerancje; narzędzie drukuje wynik,
bez nadpisywania naukowych payloadów ani capsule/package.

**7 testów interpretowanych PASS**, exit 0: odmowa przed odczytem dla
pending/failed, rzeczywisty izolowany publiczny lowering i fixture fingerprint,
odmowa niewłaściwego source tree oraz pipeline, dokładne przekazanie
wartości/run binding, propagacja mismatch i brak promocji qualification.
Pierwszy RED był brakiem modułu przy collection, nie dowodem błędu fizyki.
Testy orkiestracji mają podstawionego obserwatora/readera/oracle; **nie**
są wykonaniem natywnego solvera. Niezależny przegląd obu nowych plików
zakończony **PASS**, bez Required/Blocker; focused source-map validator
i scoped diff check również PASS.

Narzędzie nie implementuje ponownie wszystkich native input pins ani
ordered-bundle decodera: `native_input_pins_recomputed=false`,
`native_canonical_bundle_redecoded=false`. Native publisher pozostaje
właścicielem canonical charge/RT0/source/H i zgodności pochodnych payloadów.
Nawet przyszłe PASS oznacza wyłącznie porównanie V/H tego modelowanego,
uciętego domainu; `physics_qualified`, `durable_session_storage_qualified`
i `reuse_LLG_FFT_qualified` pozostają false, status **NOT VERIFIED**.
Brak closure/error certificate, badań zbieżności oraz pełnego łańcucha
kwalifikacji nie może zostać zastąpiony tym pojedynczym porównaniem.
Nowe narzędzie jest hostowym wsparciem po capture, nie częścią buildu
`db180d706d8544ec9325d24be260a8fc` i nie zmienia jego tożsamości.

Obserwacja 18:06 UTC: w tym samym jobie etap `native-build` zakończony
exit 0, duration 1268288.966 ms; trwa `frontend-dependencies`.
Brak jeszcze terminalnego receipt pełnego pakietu i actual RAM solve
poprawionej kapsuły. T05/T06/T12/T18 pozostają otwarte.

Aktualizacja 18:18:22 UTC: ten sam worker
`10fb739c5b3e03b78cd3e3756eba0e8da4e3680e88e7d89219f5f5cc92e43483`
zakończył się o 18:16:18.012530445 UTC: `exited`, exit 0, OOM false,
bez błędu kontenera. Wszystkie trzy etapy mają exit 0:
native-build 1268288.966 ms, frontend-dependencies 2301224.622 ms,
frontend-build 231085.122 ms. TypeScript i statyczny Control Room
zbudowane poprawnie. Job API nadal `running`; worker koordynatora alive,
worker_error null, terminalny receipt pakietu jeszcze niepotwierdzony.
Nie uruchomiono kolejnego buildu, nie zwolniono lease ani nie wykonano
solvera przed zakończeniem pełnego validatora. Dowód pozostaje oddzielony
od runtime, porównania V/H i kwalifikacji modułu.

### Checkpoint 2026-10-05 — odczyt dokładnego eksportu V/H

Dodano `scripts/antenna_inspection_export.py::read_inspection`: ograniczony
odczyt konkretnego rekordu `inspect_antenna`, jednego outputu i dokładnej
rewizji `inspection`. Sprawdza namespace, digest uporządkowanego manifestu,
wszystkie pięć hashy payloadów, komplet sześciu plików rewizji, jednostki,
layout, cardinality 16 device nodes / 4 probe nodes i lane FEM CPU/double.
Zwraca pełne V/H wraz z pozycjami i stable IDs dla niezależnego oracle.
`::manifest_digest` zachowuje leksykalne liczby zapisane przez serde;
ponowne serializowanie floatów przez Python mogłoby zmienić np. `1e-6`
na `1e-06` i błędnie odrzucić właściwą rewizję.

**18 interpretowanych testów PASS**, exit 0, i niezależny review źródeł PASS.
Testy używają jawnie syntetycznego, niekanonicznego bundle — nie są native
proof. Odmowy obejmują mutacje każdego payloadu o tym samym rozmiarze,
przepisany digest z błędnymi jednostkami/lane/count/path, inną rewizję,
próbę promocji qualification, dwa outputy, duplicate JSON, nonfinite JSON,
extra file oraz wyjście poza root. Początkowy outside-root test błędnie
oczekiwał `ValueError`; poprawiono go do rzeczywistego kontraktu resolvera
`StorageError`, bez zmiany odmowy ścieżki.

Reader **nie** jest authoritative ordered-bundle decoderem ani kontrolą
autentyczności wykonania. Zachowuje `native_canonical_bundle_redecoded=false`,
`physics_qualified=false` i `NOT VERIFIED`. Canonical charge/RT0/source/H
i zgodność payloadów pochodnych z bundle nadal należą do natywnego publishera.
Caller musi osobno zweryfikować managed build/input/run provenance, następnie
porównać actual V/H z oracle; nie wolno przedstawić syntetycznych testów
readera jako wykonania tego łańcucha. Wszystkie nowe pliki są zależnym WIP,
po capture, bez przypisywania ich aktualnemu buildowi.

Obserwacja 16:21:14 UTC: worker
`d9c00fcee66390cdd64e776ec9ec611cc647fdb850a196a5081cecffdf38d204`
jest `exited`, exit 0, OOM false; zakończył się o 16:15:14.928068425 UTC.
Wszystkie trzy etapy (`native-build`, `frontend-dependencies`, `frontend-build`)
mają exit 0. Kolejka tego samego jobu nadal running i brak terminalnego
coordinator receipt. Health koordynatora: worker_alive true, worker_error null.
Nie restartowano ani nie zgłoszono nowego buildu. Test anteny RAM jeszcze
nie wystartował; zbudowane artefakty nie dowodzą V/RT0/H ani końca modułu.

### Checkpoint 2026-10-05 — zatwierdzony test naukowy z sesją w RAM

Użytkownik jawnie zatwierdził wyłącznie mały test naukowy w RAM z eksportem
na D:, nie nowy trwały adapter, named volume, WSL ani osłabienie 9p guard.
Dodano `scripts/run_managed_antenna_ram.py::start`, `::observe` oraz osobne
recepty `run-managed-antenna-ram` / `observe-managed-antenna-ram`.
Ścisły dispatch `scripts/just_storage_shell.sh` wykonuje tylko helper tego
checkoutu z argumentami zgodnymi z receptą, bez generic heavy-build wrappera.
Nie kompiluje, nie instaluje i nie zmienia aktywnego buildu.

Sesja/cache/wynik solvera są na ograniczonym tmpfs 768 MiB; jedyny writable
bind to eksport pod nowym runem profilu `managed-antenna-ram-cpu` w storage
projektu. 2 CPU, 2 GiB RAM, 128 procesów, UID/GID 65532, rootfs read-only,
brak sieci, portów, capabilities, named volumes i podwyższonych uprawnień.
Przed startem i obserwacją weryfikowane są terminalny build receipt, trusted
documents, hashe pakietu, kapsuła, bazowy commit i oba snapshot digests.
Trzy osobne wejścia przykładu mają stałe SHA-256; CLI otrzymuje także
`--expect-script-sha256`. Observer sprawdza actual Cmd/Entrypoint/Env,
WorkingDir, Compose project/service, mounty, limity i tmpfs, a nie tylko
deklarację Compose. Status inny niż `exited` pozostaje pending.

**33 interpretowane testy PASS**, exit 0: actual fixture pin, mutacje
command/env/owner/isolation, pending states, OOM/nonzero oraz rzeczywisty
validator odrzucający zmienione bajty pakietu/kapsuły bez zmiany rozmiaru.
Niezależny review źródeł i regresji: PASS po naprawie trzech Required;
reviewer nie uruchamiał Dockera ani solvera. Focused validator mapy planu,
scoped diff oraz Bash syntax check: PASS. Mieszane EOL mapy naprawiono
wyłącznie w dotkniętym bloku, z kontrolą niezmienności sparsowanego JSON.
Próba przez `just` dotarła do właściwego helpera i odmówiła przed Dockerem:
aktywny job nie ma jeszcze terminalnego `receipt.json`. To oczekiwane
oczekiwanie, nie błąd solvera. Pierwszy test suite nie mógł utworzyć katalogu
na D: w sandboxie; po zatwierdzonej eskalacji testy wykonano bez zmiany rootu.

Obserwacja 16:01:13 UTC: `native-build` tego samego jobu
`fad6f31076494ca39938191358e77159` zakończony exit 0; cały job nadal running
w `frontend-dependencies`, potem pozostaje `frontend-build`. Nie ma dowodu
actual V/RT0/H ani porównania native z oracle. Nawet przyszły exit 0 tej
recepty oznacza tylko `solver_succeeded_comparison_pending`; wymagane są
inspection stage record, canonical bundle i porównanie naukowe. Nie jest to
zaliczenie T05/T06/T12/T18, full closure, trwałości ani bazy LLG/FFT.
Nowe pliki pozostają zależnym WIP z przykładem i publicznymi source types;
nie należą do aktualnie budowanej kapsuły.

### Checkpoint 2026-10-05 — niezależny wzorzec V/H dla current-source

Dodano `scripts/antenna_current_source_oracle.py::compare_fixture`, który
porównuje 16 potencjałów device i wszystkie cztery wektory pola w probe.
Przed liczbami wiąże rzeczywiste original device/probe MeshIR, całe current
transport i port mode z dokładnym wejściem przykładu. Potencjały mają osobny
gauge każdej gałęzi; oczekiwane left-minus-right drop to +0.25 V signal
i -0.25 V return. Pole dwóch pełnych modelowanych pryzmatów ma dokładną
całkę po osi prądu i niezależną kwadraturę przekroju; nie używa RT0/tet
quadrature solvera i nie przybliża prądu filamentem.

**8 interpretowanych testów PASS**, exit 0. Bezpośrednia niezależna całka
objętościowa 3D ma dwa poziomy i oczekiwaną zbieżność drugiego rzędu;
kontrolowane są także znak, H w A/m zamiast B w T, permutacje, osobne gauge,
pełna membership, input pin, niefinitywne dane i exhaustion. Pierwsza
kwadratura Simpsona do 128 podziałów nie osiągnęła progu 1e-10 A/m;
dodano ograniczony poziom 256 bez zmiany progu. Kwadratura 3D midpoint
32³ miała zbyt duży błąd; dodano 64³ oraz ratio dwóch błędów, bez
rozluźniania tolerancji. Nie jest to regresja RED produkcyjnego solvera.

Wyprowadzenie, jednostki, ważność i path+symbol maps zapisano w sekcji
`antenna-current-source-fixture-oracle` noty 0950. Niezależny przegląd
matematyki oraz źródeł nie znalazł Blocker/Required. Focused validator
0950 i scoped diff check: PASS. Zbieżność oracle nie jest ścisłym error
certificate; brakujący zewnętrzny obwód i truncation nadal niekwalifikowane.
Caller musi oddzielnie powiązać actual native bundle z actual request oraz
sprawdzić jego integralność. Nie wykonano porównania native ani solvera,
unit tests nie kompilowano. Jest to przygotowana kontrola do właściwej
bramki, nie zaliczenie T05/T06/T12/T18 ani bazy LLG/FFT.

Nowe pliki zależą od nadal niezatwierdzonego przykładu/source types i
pozostają razem jako WIP, bez osobnego commita udającego działanie na HEAD.
Nie należą do wcześniejszej kapsuły. Obserwacja 15:30:05 UTC: ten sam job
`fad6f31076494ca39938191358e77159` nadal `running`, exit null; log przeszedł
do budowy natywnego Python core. Brak terminalnego receipt całego pakietu.

### Checkpoint 2026-10-05 — dokładny snapshot w launcherze przeglądarki

Commit `5999324c59dd9398adc3bfbbb61557b17a7199d9` dodaje osobny
`run-managed-browser-snapshot`. `scripts/run_managed_browser.py::validate_managed_build`
wymaga pełnego bazowego commita oraz dwóch różnych digestów: kapsuły źródeł
i natywnego snapshotu. Nadal używa pełnego validatora terminalnego receipt,
trusted documents i wymaganych artefaktów. Domyślna trasa wymaga clean
commita i kapsuły `commit`; nowa trasa wymaga kapsuły `snapshot` oraz
dokładnego clean/dirty startup stamp z zaakceptowanej tożsamości buildu.

Interpretowane regresje obu plików launchera/archive: **58 PASS, 1 skip**
(Windows nie pozwala utworzyć izolowanego symlinku). Nie kompilowano testów.
`scripts/test_run_managed_browser.py::test_run_refuses_capsule_mismatch_before_docker_or_storage_initialization`
wykonuje rzeczywiste sprawdzenie receipt i kapsuły: oba kierunki błędnego
trybu, błędny commit w obu trybach i zmienione bajty o tym samym rozmiarze
w obu trybach. Odmowy następują przed Dockerem i inicjalizacją storage.
Niezależny przegląd uzupełnionej regresji nie znalazł blokera; parser recepty
i staged diff check przeszły. Pozostały zależny WIP nie wszedł do commita.

Nie uruchomiono kontenera przeglądarki ani solvera i nie osłabiono odmowy 9p.
Adapter trwałego storage pozostaje otwarty. Ten przyrost powstał po capture
jobu `fad6f31076494ca39938191358e77159`; nie należy do jego kapsuły.
Ostatnia kontrola API potwierdziła `running`, exit code null. Log wykazał
zakończenie kompilacji CLI release, po czym kompilację API; brak terminalnego
receipt i hashy całego pakietu. Nie jest to odbiór T12, T18 ani fizyki.

### Checkpoint 2026-10-05 — uruchomiona kompilacja i przykład current-source

Obserwacja o 14:34 UTC: ten sam job
`fad6f31076494ca39938191358e77159` jest `running`, exit code nie jest jeszcze
znany. Log ma rzeczywisty start `native-build` przez `make install-cli-dev`
w workerze oraz kompilację `fullmag-fem-sys`, `fullmag-ir` i
`fullmag-authoring`. Nie jest to jeszcze terminalny receipt ani dowód
wykonania solvera. Nie uruchomiono drugiego buildu, nie zmieniono kapsuły,
workerów, cache ani lease.

Dodano `examples/fem_antenna_current_source_inspection.py` z dwoma małymi
wersjonowanymi MeshIR i pięcioma interpretowanymi regresjami Python. Jeden
niemagnetyczny source object zachowuje oryginalną rozłączną siatkę
signal/return, cztery leady i podpisane terminal currents; osobny magnetic
probe zapewnia obecny session carrier. Jedyny etap to `antenna_field_solve`,
bez Relax/Run i bez legacy Oersted/spin transport. Requested execution to
FEM/CPU/double/strict. Kontrole source/target geometrii, interfejsów, znaków,
export/reimport oraz rzeczywistego lowering oryginalnych assetów: **5 PASS**.
Nie kompilowano unit tests. Poprzednie testy source-layout nie zastępują
wykonania tego przykładu. Nowe pliki powstały po capture; bieżący release
build nie obejmuje ich i nie może być ich dowodem.
Przegląd wejścia nie znalazł jednoznacznego źródłowego blokera native solve;
nie jest to wykonanie Rust plannera ani ABI. Obie zmienione source-map
przeszły walidację, scoped diff check jest czysty. Fragment pozostaje WIP
razem z zależnymi publicznymi typami i producentem, bez osobnego commita
sugerującego działanie na samym HEAD.

Niezależny przegląd wskazał konkretną granicę następnego wykonania:
`run_managed_browser.py::validate_managed_build` dopuszcza wyłącznie clean
commit, a `run` kapsułę `source_mode=commit`; nie obsługują bieżącego WIP
snapshotu. Dodatkowo session writer i launcher odrzucają storage Linux/9p
bez kwalifikowanego adaptera trwałości. Nie osłabiono tych kontroli, nie
zainstalowano SDK, nie dodano named volume ani WSL. Potrzebny jest adapter
odczytujący dokładny snapshot receipt i artefakty bez ponownego buildu oraz
rzeczywiście wspierane session storage.

Po udanym buildzie: zweryfikować receipt i hashe, uruchomić nowy przykład
zatwierdzoną trasą, zbadać actual V/RT0/H i niezależne oracles, następnie
zbieżność source mesh/kwadratury/truncation oraz closure/error certificate.
`inspection_only` nie wolno promować przez usunięcie fail-closed guardów.
Dopiero kwalifikowane H-per-A umożliwia bramkę static/import/sinusoidal
consumption. T00–T18 i integracja PR nadal pozostają **nieukończone**.

### Checkpoint 2026-10-05 — aktualizacja koordynatora i pełny build snapshotu

Jawna zgoda użytkownika usunęła wcześniejszą blokadę aktualizacji
`Fullmag_build_runner`. Wykonano kolejno `runner-container-stop`, sprawdzenie
pustego slotu, `runner-coordinator-image`, `runner-container-replace`,
`runner-container-resume` oraz `runner-container-status`; wszystkie polecenia
zakończyły się exit 0. Nie usunięto cache, wyników ani kapsuł i nie instalowano
SDK Windows. Wcześniejsze trzy audyty blokady poniżej pozostają historią,
nie aktualnym stanem zadania.

Nowy obraz to
`sha256:42e643a9ecd7563a40f68187821aa15236e086778013d5e3083f4e087f6c6030`,
kontener `f7e9198503a21fcef227a4cea3a882ee8d64bcce1dad54d308dfdd98270fb8d2`.
Faktycznie importowany trusted `materialize_capsule` ma SHA-256
`c80bef002ad0abfaf7c780c02420383d1f46819a16901a09afb18d1f67b66c1b`,
zgodny z obecnym źródłem; używa `copyfile`, nie `copy2`. Worker jest żywy,
przyjmuje zadania i nie zgłasza błędu. Dowód operacji i tożsamości zapisano
w `storage/tmp/<worktree-id>/windows-api-source-check/coordinator-update-20261005.json`.
Zdrowie koordynatora nie jest dowodem wykonania solvera.

Capture wykazał dwie kolizje nowego mastera z heurystyką sekretów: produkcyjny
`start-screen.tokens.css` i jego wersjonowana kopia dokumentacyjna. Po odczycie
obu arkuszy dodano wyłącznie dokładne wyjątki ścieżek, bez globalnego wyjątku
CSS lub zmiany heurystyki credential/token. Commity:
`938d3e3b8efcd9310d140b98c2e3c042e9d3dee0` i
`751355d3fbef426a73e1f217e529d0ce3ecaebef`.
Interpretowana regresja capture przeszła RED → GREEN: pięć kontroli PASS,
uzupełnienie drugiej ścieżki dwie kontrole PASS, w tym odrzucanie podobnych
nazw poświadczeń; nie kompilowano testów jednostkowych. Przeskanowano cały
indeks pod kątem pozostałych nieadministracyjnych kolizji polityki.

Przy wstrzymanych edycjach zgłoszono `snapshot`, nie `commit HEAD`, przez
repozytoryjnego klienta i skonfigurowany profil `fem-cpu-release`. Wszystkie
50 wymaganych untracked plików wskazano jawnie. Zależny WIP zachowano.
Job `fad6f31076494ca39938191358e77159` został przyjęty i ma stan `running`:

- HEAD kapsuły: `751355d3fbef426a73e1f217e529d0ce3ecaebef`;
- source digest: `657936c0fada55c9635e70ce407819b808fa9db3d9e296db86e1fb455ca2025f`;
- native snapshot: `26f72132b9f0d7d4ab8ea7695cf1cbbd53d6cde6371cdd956c53315332d88f0d`;
- capture ID: `078ced7208834d5b94e40155c77c0121`;
- request key: `antenna-wip-20261005-751355d3f-d804ab16`.

Build, runtime anten, fizyka i wydanie pozostają **NOT VERIFIED** do odrębnych
dowodów. Odczyt około 13:51 UTC potwierdza `running`, zdrowy koordynator
i zajęty job, lecz nadal brak kontenera kompilacyjnego oraz pusty log:
stan kolejki nie dowodzi rozpoczęcia kompilacji. Kapsuła ma 7418 plików,
306804959 bajtów i dokładnie 50 jawnych untracked wejść. Timeout obserwatora
124 nie anulował joba ani nie zwolnił lease. Nie uruchomiono drugiego buildu.
Build wymaga jeszcze rzeczywistego startu i terminalnego wyniku.
**Późniejszy odczyt:** worker wystartował o `2026-10-05T13:57:45.336747512Z`;
Docker inspect potwierdza żywy kontener
`d9c00fcee66390cdd64e776ec9ec611cc647fdb850a196a5081cecffdf38d204`
z obrazem `sha256:e360637ea8b00e280efdca7648ee022e6dd16150b10130b734425bb8a65b5aa0`.
Journal ma fazę `start-requested`, a kolejka nadal `running`. Faktyczny
`/runner/build_entrypoint.py` w tym workerze ma hash
`c80bef002ad0abfaf7c780c02420383d1f46819a16901a09afb18d1f67b66c1b`;
odczyt samego symbolu `materialize_capsule` potwierdza `copyfile=true`,
`copy2=false`. Użytkownik to `65532:65532`, rootfs jest read-only,
`privileged=false`, mounty `/source` i `/runner` są read-only. Dowód rozszerza
ten sam `coordinator-update-20261005.json`. Potwierdza start i trusted kod,
nie terminalny build ani wykonanie/kwalifikację anten. Wcześniejsze odczyty
braku workera zachowano jako historyczne. Nie zmieniano aktywnego workera,
źródeł kapsuły, cache ani lease.
Najbliższy krok: obserwować ten job, sprawdzić terminalny wynik,
receipt i wymagane hashe; następnie wykonać pełny solve przewodnika 3D
i rzeczywiste static/import/sinusoidal consumption. T00–T18 oraz integracja
PR nie są zakończone. Zakaz kompilowania unit tests pozostaje w mocy.

### Checkpoint 2026-10-05 — świeży audyt trasy runtime po korekcie importu

Poprzednia tura była postępem: commit
`29eee1cc6294998c162f2b94ae4ce263ca917aec` naprawił globalny carrier importu.
Następna kontrola dotyczyła możliwości zbudowania i uruchomienia bieżącego WIP,
nie kolejnego source-only zamiennika bramki runtime.

`just runner-container-status` poza sandboxem zwrócił exit 0: dokładny
kontener `d2cc72b9ee2a9891c6056228379571dadd0ab8c41910a1e06932ced198bd73b3`
jest zdrowy, `accepting_jobs=true`, `worker_alive=true`, brak błędu i aktywnych
jobów. Operatorowy katalog obrazów konfiguruje jedynie `fem-cpu-release`;
szersza lista profili dopuszczonych przez API nie jest ich konfiguracją.

Odczyt faktycznie importowanego `local_runner.build_entrypoint` w tym
kontenerze potwierdził `/opt/runner/scripts/local_runner/build_entrypoint.py`,
SHA-256 `5cfafb9b4ab4488050dc8545fa1721d4a57555b9cdd58528ae1cc222ccf8a906`
i `materialize_capsule` z `shutil.copy2`. Bieżący plik źródłowy
`scripts/local_runner/build_entrypoint.py::materialize_capsule` używa
`shutil.copyfile`, hash pliku
`c80bef002ad0abfaf7c780c02420383d1f46819a16901a09afb18d1f67b66c1b`.
Nie zgłoszono buildu na starym trusted materializerze: zachowanie mtime
może pozorować aktualność zależności współdzielonego cache. Kod przesłany
w kapsule nie zastępuje zaufanego kodu koordynatora.

Osobno resolver `windows-native-fdm-cpu-dev` wskazał zarządzany
`RUSTUP_HOME` pod `storage/cache/windows/rustup`. Sprawdzono brak zarówno
tamtejszego `fullmag-native-x86_64-pc-windows-msvc/bin/rustc.exe`, jak i
hostowego SDK nightly używanego przez
`scripts/windows/run_fullmag.ps1::Ensure-NativeRustToolchain`.
Nie instalowano SDK ani nie zmieniano toolchaina.

Dowód odczytów: `runtime-route-probe-20261005.json` pod
`storage/tmp/<worktree-id>/windows-api-source-check/`; ma
`qualification=NOT VERIFIED`, `job_submitted=false`,
`container_restarted=false`, `runtime_started=false`, `cache_deleted=false`.
Następny krok wymaga zgody na nazwaną aktualizację wspólnego koordynatora:
kontrolowana pauza i ponowny odczyt pustego slotu → obraz aktualnego trusted
materializera → kontrolowana wymiana → health/hash → jawny snapshot WIP
z wymaganymi untracked wejściami → build i odrębna kwalifikacja runtime.
Przygotowanie SDK Windows pozostaje osobną decyzją, nie warunkiem aktualizacji
koordynatora. Nie obchodzono kolejki ani zakazu kompilowania unit testów;
pełny T00–T18 pozostaje otwarty.

**Zamknięcie audytu blokady — 2026-10-05, 01:45:38 UTC.**
Trzy kolejne tury potwierdziły tę samą przeszkodę: brak zgody na aktualizację
wspólnego trusted koordynatora. Ostatni read-only health/hash nadal wskazuje
ten sam obraz i materializer `copy2`, zdrowy worker oraz pustą kolejkę.
Nie ma aktywnego joba, na który należałoby czekać. Ścieżka Windows nie ma
wymaganego SDK, a unit tests pozostają objęte zakazem kompilacji.
Lekkie kontrole źródeł nie mogą zastąpić następnej wymaganej bramki wykonania.
Cel należy oznaczyć `blocked`, nie `complete` ani `paused`; zakres T00–T18
pozostaje niezmieniony. Worktree i cały WIP są zachowane, indeks pusty,
bez restartu, instalacji, nowego enqueue lub usuwania danych. Wznowienie wymaga
decyzji użytkownika o kontrolowanej aktualizacji `Fullmag_build_runner`.

### Checkpoint 2026-10-05 — korekta globalnego carrieru importu FEM

Poprawkę, dwa fixture’y Rust, siatkę i ten checkpoint zapisano w commicie
`29eee1cc6294998c162f2b94ae4ce263ca917aec`. Szerszy zależny WIP oraz
interpretowane kontrole routingu pozostają poza tym commitem.

Przegląd commita `c9c1d0334169529b9d374fe5c637fd7bc51717a1` wykazał,
że legalny lokalny `SampledField` magnesu nie musi mieć liczności globalnego
stanu runtime. `crates/fullmag-plan/src/fem.rs::assign_domain_initial_for_segments`
dopuszcza oba warianty authoringu; import płaskiego stanu musi być ostrzejszy.
`crates/fullmag-cli/src/step_utils.rs::validate_imported_magnetization`
sprawdza teraz dodatkowo wynikowy plan: FDM wymaga liczności
`initial_magnetization`, multilayer sumy natywnych wektorów wszystkich warstw
(nie union-grid), a FEM, FemEigen i FemFrequencyResponse całego `mesh.nodes`.
Niezgodność kończy preflight przed publikacją, bez niejawnego resamplingu.

Druga korekta w `crates/fullmag-cli/src/step_utils.rs::apply_continuation_initial_state`:
istnienie shared-domain assetu uruchamia odczyt liczności rozwiązanej siatki
także przy `mesh=None, mesh_source=Some(...)`. Poprzedni warunek zależny od
inline mesh odrzucał legalny globalny import wielu magnesów z pliku.
Kanoniczny loader nadal odpowiada za format i walidację siatki.

Regresje Rust zapisano jako
`step_utils::imported_fem_state_requires_global_nodes_not_local_initializer`
(4 lokalne wektory legalne dla authoringu, 5 globalnych wymagane przy imporcie)
oraz `step_utils::imported_fem_state_supports_multi_magnet_source_only_mesh`
(5 węzłów pliku, 8 rozwiązanych węzłów po pakowaniu interfejsu per obiekt;
import 8 akceptowany, 5 i 7 odrzucane według zapisanych oczekiwań).
Obie sprawdzają niezmienność bazowego IR. Wersjonowana siatka
`crates/fullmag-cli/tests/fixtures/import_shared_domain.mesh.json` eliminuje
potrzebę tworzenia tymczasowych plików testowych. Te testy **nie zostały
skompilowane ani wykonane**; pozostają do uruchomienia po odwołaniu zakazu.

Dowody ograniczone do źródeł: RED trzech nowych oczekiwań (2 failures,
1 error) → **26 PASS** w `scripts/test_antenna_observation_source.py`.
`just check-cli-source`: końcowy receipt `5a083d2acd1d481da2ae604000c304a8`,
**passed**, exit 0, HEAD `c9c1d0334169529b9d374fe5c637fd7bc51717a1` z WIP,
digest przed/po `05e2b4affddd5a69dde1eef1515de53885840cecdee9224efd431f400f496a15`,
`source_changed_during_run=false`. To check produkcyjnych typów CLI,
nie kompilacja testów ani wykonanie FEM/GPU. Wynik nie kwalifikuje fizyki,
import events, atomowości uploadu, spatial identity ani pełnego T00–T18.

### Checkpoint 2026-10-05 — prywatna walidacja importu przed publikacją

Samodzielny zakres preflight, test i checkpoint zapisano w commicie
`c9c1d0334169529b9d374fe5c637fd7bc51717a1`; nie obejmuje on szerszych
niezacommitowanych zmian prepared bases, ACK ani natywnych operatorów anten.

`crates/fullmag-cli/src/step_utils.rs::validate_imported_magnetization`
klonuje bazowe IR, stosuje istniejące `apply_continuation_initial_state`
i uruchamia kanoniczny planner na prywatnym kandydacie. Pierwsza wersja
odrzucała błędy planowania, lecz nie odróżniała lokalnego initializeru FEM
od globalnego carrieru; korektę i jej zakres opisano w checkpointcie powyżej.
Helper nie tworzy runtime, nie ładuje bazy anteny, nie uruchamia solve/LLG
i nie przepisuje zegara segmentu ani waveformu. Nie zmienia równań, jednostek,
publicznego Python ani `ProblemIR`.

`crates/fullmag-cli/src/orchestrator.rs::run_script_mode` wiąże walidację
z odczytem importu przed pierwszym Solve: failure używa istniejącej gałęzi
odmowy, bez zmiany magnetyzacji, cache i metadanych continuation.
`crates/fullmag-cli/src/interactive_runtime_host.rs::load_state` wywołuje
walidację także wtedy, gdy host nie zachowuje idle runtime; sprawdzenie
poprzedza przygotowanie/upload, generation i publikację live state.

Dowód produkcyjnych typów: `just check-cli-source`, receipt
`2883cad87f2241f0afa8091c1d1fb24f`, **passed**, exit 0,
HEAD `f5c23bbc9e9d043ee0ee63d34752387d76044ddc` z WIP, digest przed/po
`96c6be6b7910be390e7cd82a48d563dc4519024d9ab3711a5126909a1dc65075`,
`source_changed_during_run=false`. Receipt/log zachowano pod resolverowym
`storage/builds/<worktree-id>/windows-api-source-check/cli-source-check/`.
Kontrole routingu bieżącego WIP: RED trzech nowych oczekiwań → **23 PASS**;
nie jest to wykonanie eventów importu ani solvera.

`crates/fullmag-cli/src/step_utils.rs::imported_magnetization_validation_rejects_wrong_size_without_mutating_problem`
zawiera scenariusze pustego, krótkiego, długiego i poprawnego FDM carrieru
oraz porównanie pełnego IR przed/po. Test Rust **nie został skompilowany ani
wykonany**, zgodnie z zakazem kompilowania unit testów.

Granice: płaski stan bez metadanych siatki nie dowodzi zgodności przestrzennej
dwóch carrierów o tej samej liczności i nie upoważnia do niejawnego resamplingu.
To preflight wejścia, nie dowód atomowego uploadu GPU, rollbacku po błędzie
urządzenia ani pełnego recovery. Nie zmienia kwalifikacji żadnej z czterech
realizacji FDM/FEM CPU/GPU. Następne bramki: rzeczywisty import/static/sinusoidal
consumer, RF resume, natywny przewodnik 3D, cztery lane i T18/PR.

### Checkpoint 2026-10-05 — dokładna tożsamość wyników komend obserwacji/importu

Zakres: `compute_fields`, `compute_energies` i `load_state`; bez zmiany równań,
jednostek SI, publicznego Python, `ProblemIR` ani schematu OpenAPI.
`crates/fullmag-cli/src/types.rs::EngineLogEntry` emituje istniejące opcjonalne
pole API `command_id`. `crates/fullmag-cli/src/live_workspace.rs::push_command_log`
zapisuje wynik i przechwycone ID pod jednym lockiem przed publikacją snapshotu.
Wszystkie 16 terminalnych producentów tych komend w
`crates/fullmag-cli/src/orchestrator.rs::run_script_mode` korzysta z ID
obsługiwanej komendy: 7 przed Solve oraz 9 w ścieżce interaktywnej.
`crates/fullmag-cli/src/formatting.rs::upsert_engine_log_tail` nie nadpisuje
skorelowanego wpisu wyniku podczas aktualizacji zwykłych logów.

`crates/fullmag-api/src/session.rs::command_has_terminal_log` dla tych trzech
rodzajów wymaga zgodnego ID, terminalnego markera i czasu nie wcześniejszego
niż dispatch. Wynik innej komendy, nawet z tej samej milisekundy, nie stanowi
potwierdzenia. `infer_dispatched_command_completion` dodatkowo wymaga dla pól
gotowości wszystkich zamówionych quantity/scope/generation/carrier. Sam cache
nie zamyka komendy. Failure pozostaje sprawdzany przed success. Pozostałe
rodzaje komend zachowują dotychczasową semantykę; nie jest to globalna migracja ACK.
Stary producent bez ID pozostawi te komendy pending — brak niejawnego fallbacku
do dopasowania wyłącznie przez marker/czas. Bridge zachowuje opcjonalne ID;
generowane typy frontendu nie wymagały zmian w tym przyroście.

**Dowody:**

- `scripts/test_antenna_observation_source.py::AntennaObservationSourceTests`:
  po wcześniejszym RED trzech kontroli korelacji wykonano **20 PASS**, exit 0.
  Jest to kontrola kodu i pokrycia fixtures, nie wykonanie zdarzeń API ani solvera.
- `just check-cli-source`: receipt `548a8f58173c49158edcf01e4f68d610`,
  **passed**, exit 0, HEAD `f5c23bbc9e9d043ee0ee63d34752387d76044ddc`,
  source digest przed/po
  `3137b2881ccaa4616b81675107126c21a0cc0dad5f4138151dfef381e8a97ba7`;
  `source_changed_during_run=false`. Produkcyjne CLI/API sprawdzone bez
  kompilowania unit testów i native solverów. Receipt/log:
  `windows-api-source-check/cli-source-check/548a8f58173c49158edcf01e4f68d610`
  pod resolverowym `storage/builds/<worktree-id>/`.
- `crates/fullmag-api/src/session.rs::snapshot_reconciliation_requires_fresh_exact_identity_for_compute_and_import_results`:
  przygotowano sześć scenariuszy success/failure z brakującym/cudzym ID,
  starym czasem oraz dokładnym ID w chwili dispatch. Gotowość pól jest osobno
  potwierdzana przed kontrolą korelacji. Scenariusze Rust **niekompilowane i
  nieuruchomione** zgodnie z zakazem; brak dowodu wykonania tych asercji.
- Fixtures brakującej quantity i pending materialization otrzymują właściwy
  wynik przed negatywną kontrolą readiness. W
  `crates/fullmag-api/src/router_v2/tests.rs::publish_compute_fields_result`
  pięć scenariuszy jawnie publikuje wynik; dispatch i reconciliation go nie
  fabrykują. Testy routera również nie zostały skompilowane ani wykonane.

Przyrost dotyczy wspólnej granicy CLI/API; nie zmienia kwalifikacji FDM CPU,
FDM GPU, FEM CPU ani FEM GPU z macierzy poniżej. Log pozostaje ograniczony do
256 wpisów, a publisher scala wakeups: wyparcie nieodebranego wyniku może
pozostawić komendę `dispatched`. Właściciele przejściowego bridge to CLI
publisher i API ledger; warunek jego usunięcia to trwały typed command outcome
z replay/recovery i wykonywalnym testem burst/eviction. Exact ID rozwiązuje
błędną korelację, nie trwałość ani transakcyjność importu.

Wcześniej wskazaną walidację importu pre-host/non-retained przed publikacją
uzupełnia nowszy checkpoint preflight powyżej. Nadal wymagany jest rzeczywisty static/import/sinusoidal gate,
RF resume, kontenerowa kwalifikacja 3D i cztery realizacje. T09/T12/T16/T18
oraz integracja PR nadal otwarte. Zależny szerszy WIP pozostaje zachowany.

### Checkpoint 2026-10-05 — przygotowane bazy w obserwacji i odmowa pozornego sukcesu

Zakres T09/T12 obejmuje implementację źródłową, nie odbiór fizyczny.
`crates/fullmag-cli/src/antenna_workflow.rs::plan_antenna_observation`
planuje dokładnie przekazane IR, następnie
`materialize_antenna_consumer_plan` po wspólnym activation preflight pobiera root bieżącego run przez
`crates/fullmag-cli/src/live_workspace.rs::current_artifact_dir` i ponownie
wykorzystuje `crates/fullmag-cli/src/orchestrator.rs::attach_solved_antenna_drive_bases`.
Loader sprawdza aktualne zależności i integralność immutable rozwiązania oraz
wykonuje istniejącą projekcję FEM/FDM. Nie uruchamia solve przewodnika,
nie zmienia `StudyKind`, aktywacji drive, początku segmentu ani origin waveformu.
Requested intent i resolved execution zachowują istniejącą semantykę;
validation errors brakującej/starej bazy nie są zamieniane na zero pola.
Unsupported combinations pozostają odrzucane przez obecny planner/loader.

`crates/fullmag-runner/src/lib.rs::snapshot_planned_problem_preview`,
`snapshot_planned_problem_vector_fields` i
`snapshot_planned_problem_vector_field_batch` konsumują ten sam przygotowany
plan bez ponownego planowania. Dotychczasowe fasady przyjmujące samo IR
zachowują sygnatury i delegują do tych funkcji; same nie są loaderem artefaktów.
W CLI podłączono rekonstrukcję runtime, idle/async snapshoty i oba prywatne
kandydaty remesh. Zachowano generation fences i poprawną ścieżkę odczytu
retained runtime. Nie wyciągnięto całej orkiestracji solve z monolitu;
powyższy helper nie zamyka pierwszego checkboxu T12.

Domknięto również wcześniejszą granicę przed pierwszym Solve:
`crates/fullmag-cli/src/orchestrator.rs::refresh_problem_preview_state` i
`refresh_problem_energy_state` przygotowują bazę przed obserwacją lub
publikacją wyników. `crates/fullmag-cli/src/interactive_runtime_host.rs::ensure_base_runtime_ready`
zwraca teraz błąd zamiast go połykać. Jawne `compute_fields`,
`compute_energies` i retained-runtime import propagują odmowę; brak runtime
energii jest błędem, nie udanym no-op. `load_state` publikuje continuation
i generation dopiero po udanym przygotowaniu/uploadzie i nie uploaduje
magnetyzacji drugi raz. Idle warning nie wyłącza obsługi kolejnych komend.

`crates/fullmag-api/src/session.rs::infer_dispatched_command_completion`
nie uznaje `compute_energies` za ukończone na podstawie samego idle albo
starych scalar rows. Wymaga nowego terminalnego logu wyniku; failure jest
sprawdzany przed success. Prefixy błędu importu są zgodne z rekonsyliacją.
Nie zmieniono schematów API/OpenAPI, publicznego Python ani `ProblemIR`.
Jest to naprawa istniejącej granicy komend, nie nowy protokół ACK.

**Dowody i ich granice:**

- `scripts/test_antenna_observation_source.py::AntennaObservationSourceTests`:
  wykonane kontrole źródłowe RED (najpierw 5, następnie 3 niespełnione
  oczekiwania w rozszerzonym zakresie) → GREEN **14 PASS**, exit 0.
  Kontrole odczytują kod; nie wykonują backendów ani wynikowych wektorów.
- `just check-cli-source`: produkcyjne `cargo check --locked -p fullmag-cli
  --bin fullmag`, bez kompilowania unit testów i native solverów,
  receipt `a0bdff508c2042b8b6d242b6475d0c68`, **passed**, exit 0,
  source digest przed/po
  `dae5eb1b45a21e98f82c8af34afea5da04a579274d9f910cfee0c48ac1b69287`.
  Receipt/log są pod resolverowym profilem `windows-api-source-check/cli-source-check`.
- `crates/fullmag-api/src/session.rs::snapshot_reconciliation_keeps_energy_command_pending_until_its_result`:
  dodany scenariusz idle + stare scalars/log → pending → późniejszy błąd bazy
  → failed. Regresja Rust **nie została skompilowana ani wykonana** z powodu
  obowiązującego zakazu kompilowania unit testów.
- `crates/fullmag-runner/src/fdm/cpu/reference.rs::build_snapshot_problem_and_state`
  już ustawia `time_seconds` z początku planu. Nie zmieniano tej funkcji;
  odczyt źródła nie kwalifikuje fazy po rzeczywistym resume.

| Realizacja | Stan tego przyrostu | Otwarta kwalifikacja |
|---|---|---|
| FDM CPU | źródła i typy produkcyjnego CLI/API sprawdzone | rzeczywisty import bazy, binarny `H_ant`, niezmienność czasu/m i sinusoidalny Run |
| FDM GPU | wspólna granica planu w kodzie, urządzenie nieuruchomione | upload, waveform clock, wektory i parity CUDA |
| FEM CPU | loader/projekcja w kodzie, brak nowego solve | kontenerowy solve pełnego przewodnika 3D i obserwacja/LLG |
| FEM GPU | źródłowa ścieżka wspólnego kontraktu, brak dowodu GPU | native/device wykonanie, waveform clock i parity |

**Pozostałe luki, których ten przyrost nie zamyka:**
Historyczna luka korelacji przez sam czas/marker została naprawiona w nowszym
checkpointcie powyżej dla trzech wskazanych komend; trwały typed receipt nadal
pozostaje otwarty ze względu na możliwe wyparcie logu przed odbiorem.
Nowszy checkpoint preflight uzupełnia walidację liczności/planowania importu
non-retained i pre-host; nie dowodzi pełnej transakcyjności urządzenia.
Upload GPU nie ma wykazanego kontraktu atomowości; błąd obserwacji nie jest
autoryzacją do przebudowy solvera. Rzeczywisty import/static/sinusoidal gate,
exact RF resume, SDK/BuildRunner, pełne T09/T12/T16/T18 oraz integracja PR
pozostają otwarte. Zależnego WIP nie rozdzielono na pozornie samodzielne commity.

Uzupełnienie 2026-10-02 (staging widma): przed atomową zmianą nazwy katalogu
publisher czyta pliki staging strumieniowo w blokach 64 KiB i porównuje je
bajt po bajcie z wygenerowanymi artefaktami. Uszkodzony plik pozostaje prywatny,
a katalog staging jest sprzątany; dodano regresję źródłową przez hook przed
rename. Unit test pozostaje nieuruchomiony zgodnie z `AGENTS.md`. To nie
zastępuje cache key analizy T10. Przed publikacją runner sprawdza ponadto
kanoniczny `content_digest` manifestu, dokładnie cztery referencje binarne,
ich długości i SHA-256; regresje źródłowe uszkadzają osobno payload i manifest.
Weryfikator odrzuca również ponownie zahashowany manifest o niespójnych
jednostkach, układzie payloadów lub liczności osi/komponentów; regresja
źródłowa dla jednostki i rozmiaru widma pozostaje nieuruchomiona.
Porównanie istniejącego opublikowanego wyniku używa teraz bufora 64 KiB i
sprawdza anulowanie między blokami zamiast wczytywać cały payload do RAM;
regresja źródłowa obejmuje zmianę bajtu w trzecim bloku. Nie zapewnia to
transakcyjnej publikacji całego batcha wielu żądań: ukończony wcześniej wynik
pozostaje po anulowaniu późniejszego żądania, co wymaga osobnego projektu
publikacji batcha bez kasowania współdzielonych immutable artefaktów.
Pełna bramka T12 pozostaje otwarta bez wykonanych testów i runtime proof.
Diagnostyczny hostowy `cargo check --locked -p fullmag-runner -p fullmag-cli`
z zarządzanym targetem na `D:` zakończył się kodem 0 (2026-10-02). Nie zastępuje
kontenerowego buildu `Fullmag_build_runner`, który nadal zgłasza brak
konfiguracji kontenera, ani zakazanych obecnie testów jednostkowych.

**Pliki:** `antenna_stage.rs`, native charge/field wrappers, CLI `orchestrator.rs` i nowy `antenna_workflow.rs`, standardowy stage execution read-model i artefakty.

- [ ] Przenieść antenową orkiestrację z monolitu do `antenna_workflow.rs`; publiczne wywołanie przyjmuje plan, artifact store i callback postępu/anulowania. Nie przenosić przy tym innych workflows.
- [x] Sprawdzić cache przed emisją meshing/solving. Cache hit publikuje `ready` z `reused_existing=true` bez fikcyjnego solve; zgodny model cache publikuje `Ready`, brak pliku `Missing`, a niezgodny podpis `Stale`.
- [ ] Emitować meshing, solving_current, evaluating_field, projecting_targets dopiero na rzeczywistych granicach wykonania. Jeśli mesh jest wcześniej gotowy, oznaczyć etap jako reuse/skip z przyczyną.
- [ ] Przekazać cancellation token do długich operacji i sprawdzać go między blokami pola T11. Anulowanie nie może opublikować gotowego manifestu.
- [ ] Payloady zapisywać do task-private temporary directory, weryfikować hashe, publikować manifest jako ostatni atomowy krok. Concurrent request tej samej signature deduplikuje lub weryfikuje identyczność wyniku; nie nadpisuje istniejącego assetu.
- [ ] Na failure/cancel zapisać stage stop reason i diagnostykę, zachować poprzedni poprawny immutable wynik. Cleanup usuwa wyłącznie własne niedokończone pliki, nigdy wspólny cache ani explicit output directory.
- [ ] Wykonać resolver stage/output T08; następny stage dostaje resolved reference dopiero po poprawnej publikacji.
- [ ] Zarejestrować outputy w standardowym stage/artifact catalog. Nie ukrywać jedynego wyniku w `.fullmag` historii; zwykły script launch używa publicznego sibling `.zarr` zgodnie z launcherem repo.

Sekwencje testowe:

```text
cache miss: queued -> meshing/reused_mesh -> solving_current -> evaluating_field -> projecting_targets -> ready
cache hit:  queued -> projecting_targets(reused_existing=true) -> ready
cancel:     evaluating_field -> cancelled; no ready manifest
failure:    solving_current -> failed(reason); no downstream drive
stale:      ready -> stale(reason); old immutable artifact remains readable by its old run
restart:    reload ready manifest -> verify bytes and dependencies -> resolve consumer
```

**Stan implementacji 2026-09-12:** ścieżka `execute_antenna_spectrum_requests`
publikuje każdy wynik source-spectrum w prywatnym katalogu stagingowym i
promuje kompletny katalog jednym rename. `output_id` jest ograniczony do
jednego bezpiecznego komponentu ścieżki, a manifest `spectrum.v2.json` jest
zapisywany jako ostatni plik w stagingu; niekompletny lub uszkodzony zapis nie
może pojawić się jako gotowy output. Ponowne żądanie tego samego `output_id`
porównuje dokładny zbiór plików oraz wszystkie oczekiwane payloady
bajt-po-bajcie i reużywa identyczny wynik, natomiast dodatkowy/brakujący plik,
konflikt treści albo niebezpieczny identyfikator kończy się błędem bez
nadpisania poprzedniego assetu. Dodany test CLI obejmuje pierwszą publikację,
reuse, konflikt, obcy plik i próbę wyjścia poza katalog. Nadal pozostaje test
fault-injection dla anulowania/przerwania całego batcha wielu requestów oraz
pełne spięcie z resolverem stage/output.

Uzupełnienie implementacyjne 2026-09-12: `execute_synthetic_stage` sprawdza
zweryfikowaną, niezmienną bazę przed emisją stanów `Meshing`, `SolvingCurrent`
i `EvaluatingField`. Przy trafieniu zapisuje przejścia
`Queued → ProjectingTargets` z diagnostyką `reused verified immutable field
solution` oraz `→ Ready`, a rekord etapu zawiera `reused_existing=true` i
referencję opublikowanego assetu. Przy braku trafienia zachowana jest pełna
sekwencja rzeczywistego solve'u. Regresja lifecycle wymusza oba warianty;
anulowanie między blokami, deduplikacja równoległych solve'ów i pełny resolver
stage/output pozostają otwarte.

Uzupełnienie implementacyjne 2026-09-21: loader runnera publikuje jawny stan
`AntennaFieldSolutionCacheState::{Missing, Stale, Ready}`. Zgodny manifest nadal
omija etapy solve, lecz obecny manifest z innym `asset_id` lub podpisem nie jest
już traktowany jak zwykły cache miss: lifecycle zapisuje
`Missing → Stale → Queued` z oczekiwanym i znalezionym ID oraz ścieżką manifestu,
po czym wykonuje nowy solve do nowej rewizji content-addressed. Korupcja,
niepełny manifest lub zmiana bajtów podczas odczytu nadal kończy się błędem, a
stary immutable asset nie jest usuwany ani nadpisywany. Szczegóły zapisano w
`docs/validation/antenna/cache-lifecycle-2026-09-21.md`.

Uzupełnienie implementacyjne 2026-09-21 (wyścig publikacji): po przegranym
`rename` do revisioned assetu publisher sprawdza, czy inny worker opublikował
już kompletny manifest. Identyczne bajty są zwracane jako
`reused_existing=true`, a różna treść daje jawny konflikt immutable rewizji;
żadna ścieżka nie nadpisuje ani nie scala istniejącego katalogu. Nadal brakuje
kontrolowanego fault-injection przerwania zapisu payloadu/manifestu. Dodana
regresja `concurrent_identical_publication_deduplicates_after_rename_race`
wymusza dwóch rzeczywistych workerów barierą tuż przed `rename()` i sprawdza,
że dokładnie jeden publikuje, a drugi reużywa zweryfikowany asset. To nie
zamyka jeszcze cancellation tokena native solve ani fault injection całego
batcha.

Uzupełnienie 2026-10-02 (widmo, granica publikacji): publisher source-spectrum
ponownie sprawdza sygnał anulowania po hooku wyścigu i bezpośrednio przed
`rename()` prywatnego stagingu na gotowy katalog. Deterministyczna regresja
ustawia sygnał właśnie w tej granicy i sprawdza brak manifestu oraz usunięcie
własnego stagingu. Test pozostaje nieuruchomiony z powodu zakazu w worktree;
nie usuwa to niepreemptive szczeliny samego `rename()` ani braku testu całego
batcha wielu requestów. W ścieżce field-solve dodano także ostatni odczyt
anulowania po cache hit oraz po publikacji immutable assetu, zanim stage
udostępni status `Ready` i referencję w output catalog; anulowany stage
zapisuje stan terminalny `cancelled`. Istniejącego poprawnego immutable assetu
nie usuwa się przy anulowaniu etapu po publikacji.

Uzupełnienie 2026-10-03: `crates/fullmag-cli/src/orchestrator.rs`
(`write_antenna_stage_output_catalog_ready`) używa teraz sygnału anulowania
również przy publikacji katalogu `ready`: ponowny odczyt następuje przed
atomowym `rename()`, także przy reużyciu identycznego katalogu. Lifecycle
przechodzi do `Ready` dopiero po udanym zapisie katalogu; anulowanie przed
tym punktem zapisuje terminalne `cancelled`. Dodano regresję źródłową dla
nowej publikacji i reużycia, lecz test Rust nie został uruchomiony przez
zakaz kompilacji testów w worktree. Diagnostyczny `cargo check --locked -p
fullmag-cli` przeszedł. Wyścig atomowego `rename()` pozostaje granicą
commitu i nie jest preemptive; natywny kernel również nie jest preemptive.

Uzupełnienie 2026-10-03 (ścieżka manifestu w katalogu etapu): producent
`ready` nie stosuje już fallbacku do absolutnej ścieżki przy błędnym
`manifest_ref`. Wymaga istniejącego pliku pod kanonicznym rootem artefaktów
i względnej ścieżki z samych zwykłych komponentów; w przeciwnym razie
odmawia publikacji katalogu. Regresja źródłowa sprawdza ścieżkę poza
rootem i ścieżkę z `..`; test Rust pozostaje nieuruchomiony z powodu
obowiązującego zakazu. Diagnostyczne `cargo check --locked -p fullmag-cli`
przeszło, lecz nie stanowi kwalifikacji kontenerowej ani runtime.

Uzupełnienie 2026-10-03 (konkurencyjna publikacja katalogu): po zapisaniu
prywatnego pliku przez `create_new` katalog `ready` jest publikowany przez
atomowe utworzenie hard linku do tej samej zawartości w tym samym katalogu.
W przeciwieństwie do `rename` nie zastępuje istniejącej nazwy; konkurencyjny
identyczny wynik jest reużywany po porównaniu bajtów, a różna treść kończy
się konfliktem i pozostaje nienaruszona. Dodano deterministyczną regresję
obu przeplotów. Filesystem bez hard linków odmówi publikacji zamiast
przejść do nieatomowego fallbacku. Diagnostyczne `cargo check --locked -p
fullmag-cli` zakończyło się kodem 0. Test Rust i rzeczywisty wyścig runtime
pozostają niewykonane z powodu obecnego zakazu testów jednostkowych oraz
braku kwalifikowanego runnera.

Uzupełnienie 2026-10-02 (preflight batcha widm): CLI sprawdza bezpieczeństwo
wszystkich `output_id` i duplikaty przed rozpoczęciem obliczeń lub publikacji
pierwszego widma. Drugi wadliwy request nie zostawia więc gotowego wyniku
pierwszego z tego powodu. Regresja źródłowa obejmuje późniejszy duplikat i
ścieżkę wychodzącą poza katalog; nie została uruchomiona z powodu zakazu
testów. Nie jest to jeszcze transakcja całego batcha: błąd późniejszego
obliczenia lub `rename()` nadal może zostawić wcześniejszy poprawnie
opublikowany immutable output. Pełna atomowość wymaga stagingu na dysku i
jednego punktu commit dla zestawu, bez trzymania wszystkich payloadów w RAM.
Rozstrzygnięcie wszystkich symbolicznych referencji stage/output, portów i
oczekiwanych podpisów zależności odbywa się teraz również przed pierwszym
odczytem payloadu lub publikacją w batchu. Późniejsza błędna referencja nie
pozostawia częściowego outputu wcześniejszego requestu. Metadane oczekiwań
są przechowywane do drugiej fazy, lecz duże tablice pola i widma pozostają
przetwarzane sekwencyjnie. Ta kontrola nie wykrywa z góry korupcji payloadu
ani błędu późniejszego obliczenia i nie zastępuje transakcji batchowej.
Diagnostyczne `cargo check --locked -p fullmag-cli` dla bieżącego worktree
zakończyło się kodem 0 po użyciu zarządzanego katalogu builda z wymaganym
dostępem hosta. Nie kompilowano ani nie uruchamiano testów jednostkowych;
kontenerowy runner nadal nie ma konfiguracji. To dowód kompilacji produkcyjnego
Rust CLI i zależności, nie kwalifikacja natywnego FEM ani atomowości batcha.

Uzupełnienie 2026-10-02 (rzeczywiste granice wykonania): CLI nie zapisuje już
`Meshing → SolvingCurrent → EvaluatingField` przed pojedynczym wywołaniem
runnera. Callback z runnera oznacza użycie meshu przygotowanego przez planner
jako `Meshing` z diagnostyką reuse, zgłasza `SolvingCurrent` bezpośrednio
przed charge solve i `EvaluatingField` bezpośrednio przed RT0/Oersted. Błąd
preflight pozostawia stan `Queued`, błąd charge pozostaje w `SolvingCurrent`,
a błąd RT0/Oersted w `EvaluatingField`. Diagnostyczne `cargo check` produkcyjnego
CLI z `fem-gpu` i bez tej cechy przeszło; testów jednostkowych nie uruchomiono.
Historia lifecycle jest prawdziwsza, lecz osobna emisja realtime i pomiar
faktycznego postępu wewnątrz niepreemptive FFI pozostają otwarte.

Uzupełnienie 2026-10-02 (live stage execution): callback tych trzech faz
aktualizuje teraz `live_workspace.stage_execution` dla bieżącego etapu
`running`: `progress_label`, opis oraz `last_progress_unix_ms` są publikowane
przez istniejący resource-first kanał. Nie ustawiamy sztucznego procentu
wewnątrz niepreemptive FFI. Aktualizacja jest związana z aktywnym indeksem
etapu i nie może podmienić telemetrii późniejszego stage. Diagnostyczne
kontenerowe `cargo check -p fullmag-cli --features fem-gpu` przeszło;
browser/runtime smoke, emisja postępu w samym natywnym kernelu i testy
jednostkowe pozostają otwarte.

Uzupełnienie 2026-10-02 (tożsamość live progress): aktualizacja rekordu
etapu jest wydzielona do `update_antenna_live_stage_progress`; ignoruje obcy
indeks, etap terminalny oraz nieznaną fazę. Dodano także etykietę publikacji
bazy dla istniejącego przejścia `ProjectingTargets` zarówno po cache hit,
jak i po nowym solve. Regresja źródłowa sprawdza tożsamość, czas, opis i brak
fikcyjnego procentu, ale pozostaje nieuruchomiona. Produkcyjne `cargo check`
z `fem-gpu` przeszło; browser smoke nadal jest wymagany.

Uzupełnienie implementacyjne 2026-09-21 (granice anulowania native solve):
`fullmag_runner::execute_antenna_field_solve_plan_interruptible` przyjmuje
`AtomicBool` i sprawdza go przed/po preflight, charge transport, RT0/Oersted
oraz przed materializacją artefaktu. Pojedyncze wywołanie FFI pozostaje
niepreemptive, ale zaakceptowane anulowanie na granicy zwraca błąd przed
przekazaniem wyniku do publishera. Przekazanie sygnału przez
`orchestrator.rs`, zapis `StageStopReason::UserCancelled` i stan
`cancelled/awaiting_command` są teraz spięte dla synthetic antenna stage;
publisher sprawdza ten sam sygnał bezpośrednio przed `rename()` i usuwa
wyłącznie własny staging przy odrzuceniu. Pozostaje runtime/fault-injection
dowodzący całego batcha oraz niepreemptive granica samego `rename()`.

Uzupełnienie implementacyjne 2026-09-21 (stage/output catalog): antenowy
`synthetic` field solve zapisuje atomowo `stage_output_catalog.v1.json` po
zweryfikowanej publikacji. Katalog ma jedną wersjonowaną referencję
`stage_id → output_id → asset_id/content_digest`, względny `manifest_ref`,
quantities i informację o reuse; read-model dostaje ścieżkę katalogu jako
`artifact_ref`. Anulowanie zapisuje terminalny `cancelled` z pustym
`outputs`, a identyczny katalog jest idempotentny — odmienna treść nie może
go nadpisać. Zakres jest celowo ograniczony do antenowego synthetic stage;
pełny resolver symbolicznego stage/output i wspólny katalog wszystkich stage
pozostają otwarte. Wewnętrzny hook fault-injection po zapisie pliku
tymczasowego pozwala regresji sprawdzić cleanup przed rename.

**Bramka:** `lifecycle` i `artifact`; testy fault injection obejmują przerwanie przed/po zapisie payloadu i przed publikacją manifestu. Commit: `fix: bind antenna stage lifecycle to actual execution`.

## T13. Domknąć i zakwalifikować FEM LLG

Uzupełnienie 2026-10-02 (obserwacja `H_ant`): FEM reference odrzuca teraz
nieskończony mnożnik prądu po ocenie waveformu oraz przepełnienie sumy
obserwowanych pól rozwiązanych portów. Granica obserwacji odrzuca także
niefinitywne pole z legacy maski Zeemana i legacy źródła antenowego. Regresje
źródłowe wymuszają overflow od niezerowego offsetu sinusoidy dla portu i maski.
Nie kwalifikuje to RHS, energy/torque ani
natywnych integratorów; bramka T13 pozostaje otwarta.

Uzupełnienie 2026-10-02 (skończoność przyłożonego pola): wspólny materializer
projekcji FEM/FDM odrzuca teraz przepełnienie `peak_current_a × H_ant_basis`
przed zapisaniem resolved basis w planie LLG. Oba wejścia mogą być osobno
skończone, a ich iloczyn nie; immutable baza `H/A` pozostaje bez zmian.
Dodano regresję źródłową FDM dla tego przypadku. Walidator noty naukowej,
diagnostyczne `cargo check --locked -p fullmag-runner` i `git diff --check`
przeszły; regresja Rust oraz natywna kwalifikacja T13 pozostają nieuruchomione.

**Pliki:** runner `native_fem.rs`, `antenna_fields.rs`, `fem_reference.rs`, native `zeeman_regional_field.*`, `crates/fullmag-engine/src/fem.rs`, scenariusze `tests/antenna/scenarios/`.

- [ ] Zachować basis H/A × peak_current A → H A/m, bez drugiej konwersji mu0. Energia używa tego samego wektora i właściwych nodal weights.
- [ ] Przebieg musi być oceniany w czasie każdego rzeczywistego RK substage, także prób odrzuconych/adaptive retry. `stage_local` odejmuje fizyczny start etapu; `absolute` nie odejmuje go.
- [ ] Dla preprojected field połączyć obsługę z master mixed-mesh checks. Sprawdzić periodic constraints i czy wspólne węzły mają właściwe wartości pola.
- [ ] Chronić frozen spins i maskę magnetyczną: pole może istnieć w przestrzeni, ale RHS constraints pozostają własnością solvera. Nie zmieniać aktywności komórek przez wybór warstwy UI.
- [ ] Przygotować minimalny macrospin reference bez demag/exchange do kontroli częstotliwości precesji i fazy, następnie mały magnet z pełnymi składnikami do kontroli energii/torque.
- [ ] Wykonać oba porządki pipeline: `relax → solve → run` oraz `solve → relax → run`. Wynik Relax musi być identyczny dla domyślnie nieaktywnego RF; różnice Run muszą zgadzać się z tym samym artefaktem i waveform.
- [ ] Testować constant, sinusoidal z niezerową phase/offset, pulse, piecewise-linear i sinc. Dla każdej wspieranej explicit RK wymagać krótkiej trajektorii, nie tylko Heun.
- [ ] Zapis `H_ant`, energy, torque i magnetization ma pochodzić z faktycznie wykonanej chwili, a nie pola przy `t=0` użytego w preview.

**Bramka:** `fem-llg` przez container, plus istniejące `verify-fem-solved-antenna-drive-contract` i odpowiednie RK gates. Raport musi nazwać każdy integrator, device i precision. Pierwszy publiczny wykonywalny przykład powstaje po tej bramce, nie wcześniej.

**Korekta źródłowa 2026-10-02 (zegar FEM CPU reference):**
referencyjny integrator rozpoczyna każdy etap od czasu lokalnego zero.
`dynamic_antenna_drive_terms` wcześniej odejmowało od tego zegara fizyczny
start etapu dla `stage_local`, a dla `absolute` nie dodawało startu; naprawiono
oba kierunki oraz absolutny zegar masek i legacy anten. Dodano regresję
sprawdzającą różną fazę dwóch rozwiązanych źródeł przy starcie etapu 10 s
i czasie lokalnym 1 s, a także absolutny zegar maski Zeemana i legacy
`mqs_2p5d_az`. Test pozostaje nieuruchomiony z powodu zakazu w `AGENTS.md`;
T13 nie jest tym samym zakwalifikowane.

**Stan kwalifikacji 2026-09-12:** hostowy `cargo test --features fem-gpu` nadal
nie jest dowodem, bo `fullmag-fem-sys` nie ma kompilatora C/C++ na hoście.
Zarządzana recepta kontenerowa, uruchomiona z aktywnym Docker Desktop,
Pythonem 3.14 i zatwierdzonym `D:\git\fullmag\storage`, przeszła po naprawie
windowsowego bindu: CMake zbudował `fullmag_fem` i `fem_zeeman_contract`, a
kontrakt FFI oraz test materializacji preprojekcji zakończyły się `1 passed`.
To kwalifikuje natywny kontrakt solved-antenna→regional-Zeeman dla tej ścieżki;
pełny `fem-llg` pozostaje otwarty do czasu testów wszystkich integratorów,
waveformów, relaksacji i snapshotów wymienionych wyżej.

Uzupełnienie runtime 2026-09-12: testy `fullmag-runner` potwierdzają także
że rozwiązaną bazę można skalować `peak_current_a` i oceniać sinusoidę z
rzeczywistego czasu etapu integratora (`solved_antenna_basis_uses_peak_current_stage_clock_and_exact_term_time`),
oraz że `AllTimeEvolution` nie jest aktywne podczas relaksacji. Są to dowody
ścieżki FDM CPU/reference; nie zastępują pełnej bramki FEM LLG z tabeli powyżej.

**Uzupełnienie implementacyjne 2026-09-21 (FEM CPU `H_ant` preview):**
uzupełniono capability i materializację bezpośredniego pola anteny dla
`FemEngine::CpuNative`. Jeżeli rozstrzygnięty `FemPlanIR` zawiera
`antenna_zeeman_masks`, `solved_antenna_drive_bases` lub kompletny legacy
`mqs_2p5d_az` (`antenna` + `drive`), aktywny preview,
cache preview i terminalny cache wywołują
`compute_antenna_field_at_time(plan, source_time)` i budują wspólny
`LivePreviewField` z maską magnetyczną `H_ant`. Pole jest obserwablą preview,
nie dodatkowym termem RHS; czas i rewizja źródłowa są zapisane w metadanych
materializacji.

Nie dodano `H_ant` do natywnego katalogu snapshotów, ponieważ obecny ABI
`NativeFemPreviewObservable` nie ma tej obserwabli. FEM GPU pozostaje
fail-closed i nie dziedziczy capability CPU. Dzięki temu UI nie obiecuje
wyniku, którego backend nie potrafi jeszcze odtworzyć z urządzenia ani zapisać
w artefakcie. Ta zmiana domyka jedynie warstwę podglądu CPU; nie odhacza T13.

**Dowód builda 2026-09-21:** zarządzana recepta
`just windows-build backend=fem device=cpu frontend=dev` zakończyła kompilację
`fullmag-runner`, CLI, API i `fullmag-py-core` bez błędów. Końcowy receipt został
odrzucony przez guard tożsamości źródeł, bo build rozpoczął się na
niezatwierdzonych zmianach i worktree zmienił się w trakcie; traktujemy to jako
brak receiptu, nie jako błąd kompilacji. `rustfmt --check` i `git diff --check`
przeszły. Testów jednostkowych Rust nie uruchamiano zgodnie z blokadą sesji.

Pozostaje otwarta kwalifikacja snapshot/artifact `H_ant` (hostowa ścieżka CPU
jest zaimplementowana, natywny ABI/GPU nadal nie), FEM GPU, pełna trajektoria
LLG dla wszystkich integratorów i waveformów oraz osobne T16 dla projekcji FDM,
uploadu CUDA i parity CPU/GPU.

**Uzupełnienie implementacyjne 2026-09-21 (hostowy artifact `H_ant` FEM CPU):**
uzupełniono ścieżkę outputów native FEM CPU. `H_ant` pozostaje quantity
pochodną (`Derived`) i jest reklamowane tylko wtedy, gdy aktywny plan ma
`antenna_zeeman_masks`, `solved_antenna_drive_bases` lub kompletny legacy
`mqs_2p5d_az` (`antenna` + `drive`). Początkowy,
accepted-step, terminalny i końcowy zaplanowany output buduje hostowy
`FieldSnapshot` przez `compute_antenna_field_at_time(plan, stats.time)` w
pełnym porządku `plan.mesh.nodes`; do artefaktu trafiają rzeczywisty czas,
krok, `solver_dt` i rewizja. Streaming korzysta z istniejącego
`ArtifactPipeline`. Snapshoty `H_ant.x/y/z` zachowują istniejący payload
trójskładowy z wybraną składową i zerami w pozostałych osiach. Ścieżka GPU
pozostaje fail-closed z powodu braku `H_ant` w natywnym ABI obserwabli.

**Dowód builda 2026-09-21:** zarządzana recepta
`just windows-build backend=fem device=cpu frontend=dev` skompilowała
`fullmag-runner`, CLI, API i `fullmag-py-core`. Guard tożsamości odrzucił
końcowy receipt pierwszej próby dla niezatwierdzonego worktree. Po commicie
`c38e14692` powtórzony build z clean HEAD zakończył się `Build mode: fem-cpu`,
`Windows FEM cpu container build is ready` i kodem sukcesu. `git diff --check`
oraz formatowanie nowych fragmentów przeszły. Testów Rust nie kompilowano
zgodnie z blokadą sesji.

Ta poprawka nie odhacza T13: pozostaje dowód wartości artefaktów względem
niezależnego wzorca, RHS/LLG dla wszystkich integratorów i waveformów,
kwalifikacja GPU oraz osobna ścieżka T16 dla projekcji FDM i parity CPU/GPU.

**Uzupełnienie implementacyjne 2026-09-21 (native CPU carrier dla legacy źródeł):**
audyt wykazał, że `current_modules` wymuszały wybór CPU, ale nie były obecne w
`pack_native_regional_field_drives`; native RHS mógł więc pomijać pole widoczne
w preview. Adapter korzysta teraz z istniejącego `PREPROJECTED_NODAL`: legacy
`mqs_2p5d_az` jest wyliczane hostowo z `compute_per_unit_antenna_fields` i
skalowane przez `current_a`, a `antenna_zeeman_masks` przekazują już rozwiązany
`field_xyz`. Oba profile są w A/m, mają absolutny zegar legacy i przekazują
waveform do native ewaluacji na każdym podetapie RK. Dzięki temu ten sam
`h_drive_xyz` zasila native `H_eff`, energię i hostowy snapshot `H_ant`.

Nie promowano tej capability do GPU: selekcja `current_modules` nadal kończy
się na natywnym CPU, a GPU pozostaje fail-closed. Jest to zgodność runtime dla
legacy/maski; nie zastępuje docelowego pełnego 3D solve przewodnika. Zarządzany
`just windows-build backend=fem device=cpu frontend=dev` przeszedł w trybie
`fem-cpu` po zmianie. T13 nadal wymaga numerycznej bramki RHS/energy/torque,
wszystkich integratorów i waveformów oraz osobnej kwalifikacji GPU.

**Czysty receipt builda 2026-09-21:** po commitach `38febcef2`, `eb2559d2a`
i `780680003` ponowiono tę samą receptę na czystym HEAD
`780680003b6b21e706dfcbd49959009c10493664`. Zakończyła się kodem 0,
`Build mode: fem-cpu` oraz komunikatem `Windows FEM cpu container build is
ready`. Resolver wskazał state root
`D:/git/fullmag/storage/runtimes/microwave-antenna-latest-2026090-78aaec16ccf52671/fem-cpu`
i build root
`D:/git/fullmag/storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/windows-fem-cpu`.
Jest to dowód kompilacji i tożsamości czystego źródła, nie dowód numerycznej
zgodności LLG; testów jednostkowych Rust nadal nie kompilowano.

**Kwalifikacja native FEM LLG CPU FP64 2026-09-21:** recepta
`just verify-fem-llg-time-domain-qualification` przeszła w obrazie
`fullmag/fem-gpu:local`, z executable ustawionym jawnie na lane `cpu`.
Build i wykonanie zakończyły się kodem 0, a końcowy walidator zgłosił
`FEM LLG time-domain CPU FP64 qualification artifact PASS`. Artefakt
`.fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64/qualification.json`
ma `status: pass`, `device: cpu`, `precision: fp64`, integrator `rk45` oraz
polityki kroku `adaptive` i `fixed`; source snapshot ma digest
`8bc150aef9007662d1ff29103f9896feb760ceff51b38f3b6d35bb398670fb21`.
Wynik obejmuje macrospin dla `alpha={0.1,1,10}`, kontrolę trybu wymiany,
odrzucone próby adaptive, bilans energii oraz `relax_to_run` z dokładnym
handoffem stanu, zerowym błędem replay i świeżymi polami endpointu.

Przed kwalifikacją dodano wyłącznie adaptery zgodności dla obrazu z PETSc
3.12.4/SLEPc 3.12.2: GMRES zachowuje domyślną tolerancję w starszej wersji,
a API macierzy preconditionera jest wybierane przez wersję biblioteki.
Brakujące w publicznym nagłówku PETSc
3.12 `PetscObjectGetId` ma lokalną deklarację eksportowanego symbolu.
`MatShellSetVecType` (dostępne od PETSc 3.13) dla starego obrazu kończy
GPU modalny jawnie `PETSC_ERR_SUP`; nie jest to cichy fallback do wektorów
hostowych. Obejście pozwoliło zbudować wspólny target bez zmiany kontraktu
CPU, lecz nie stanowi dowodu wykonania GPU.

**Kontrola wariantu bez SLEPc 2026-09-22:** recepta
`just verify-fem-mixed-p1-local-interactions-native-contract` została uruchomiona w tym
samym obrazie z `FULLMAG_FEM_WITH_SLEPC=OFF`. Zarządzany build ponownie
zbudował `fullmag_fem`, `fem_mixed_p1_contract` i `fem_mesh_contract`, a
kontrakty uruchomiono bez błędu widocznego w logu. Odczyt narzędzia nie
zachował kodu zakończenia recepty; pełny PASS wykonania pozostaje
niepotwierdzony. Jest to
potwierdzenie, że adapter CPU jest bezpiecznie odizolowany od konfiguracji
bez SLEPc; nie jest to kwalifikacja modalnego GPU ani antenowego RHS.

Ta bramka zamyka bazową kwalifikację czasowego LLG CPU FP64, ale nie odhacza
T13. Nadal brakuje antenowego RHS z niezależnym oraclem, wszystkich
wspieranych explicit RK i waveformów anteny, snapshotu `H_ant`/energii/
torque z rzeczywistego czasu oraz kwalifikacji FEM GPU i T16.

**Wzorzec trajektorii 2026-09-22:**
`scripts/antenna_macrospin_oracle.py::macrospin_from_field_impulse` oblicza
niezależny wzorzec macrospinu dla pola wzdłuż osi z, z tłumieniem Gilberta
i podpisaną całką pola H po czasie (A s/m). Funkcja
`waveform_integral` obsługuje constant, sinusoidal (phase/offset), pulse,
piecewise-linear z przedłużeniem wartości brzegowych oraz sinc_pulse.
Pierwsze cztery mają całki analityczne; sinc ma niezależną, ograniczoną
kwadraturę Simpsona z kontrolą zbieżności i limitem 128 okresów w przedziale.
Wzorzec korzysta wyłącznie z biblioteki standardowej Python i nie wykonuje
solverów produkcyjnych. Jego konsument musi uwzględnić amplitudę prądu,
bazę H/A i bias oraz przesunąć zegar dla `stage_local`.

Wykonano `python -B -m unittest discover -s scripts -p test_antenna_macrospin_oracle.py`:
7 testów, PASS. Sprawdzono znak precesji, skalę gamma, tłumienie, składanie
i odwracanie impulsów, stany przy biegunie, całki przebiegów, fazę/offset,
zegar nanosekundowy i odrzucanie niepoprawnych danych. Nie kompilowano testów
natywnych. Następny krok: podłączyć wzorzec do rzeczywistych trajektorii
FEM dla macierzy integratorów i przebiegów; sama kontrola wzorca nie zamyka T13.

**Porównanie próbek 2026-09-22:**
`scripts/antenna_macrospin_oracle.py::compare_collinear_trajectory` porównuje
zapisane `time_s` i `m` ze wzorcem, mnożąc bazę H/A przez prąd w A,
dodając bias w A/m i respektując zegar `stage_local` albo `absolute`.
Nie ufa błędom zapisanym przez producenta artefaktu. Odrzuca puste serie,
brak postępu czasu, powtórzone/cofające się czasy, NaN i przekroczenie
jawnej tolerancji wektora. Zakres obejmuje jednorodny macrospin z polami
Zeemana wzdłuż osi z; pochodzenie danych i backend wymagają osobnych dowodów.

9 kontroli Python przeszło, w tym celowo błędna amplituda, dodatkowe mu0,
znak precesji i zegar. Porównano także trzy końcowe próbki istniejącego
artefaktu CPU FP64/RK45 opisanego powyżej (ten sam source snapshot):
przy polu bias 800000 A/m, początkowym m=(0.6,0,0.8) i czasie 2 ps
maksymalny błąd wyniósł 8.006e-16 dla alpha=10. Nie wykonano nowego runu.
To niezależna kontrola istniejących endpointów pola stałego; nie dowodzi
antenowego wzbudzenia, poprawności wszystkich podkroków ani macierzy RK.

**Natywna macierz antenowa CPU 2026-09-22:**
`just verify-fem-antenna-cpu-trajectories` zakończyła się kodem 0.
Istniejący program `fem_llg_time_domain_qualification` otrzymał tryb
`antenna-cpu`: przekazuje pole preprojected przez publiczne ABI, wykonuje
rzeczywisty LLG CPU FP64 i zapisuje 21 próbek na przypadek. Sprawdzono
Heun, RK4, RK23/BS oraz RK45/DP54, każdy dla constant, sinusoidal
(1 GHz, faza 0.7, offset 0.2), pulse, piecewise-linear i sinc_pulse.
Łącznie 20 przypadków, 40000 kroków i 420 próbek; krok stały 0.5 ps,
czas 1 ns, alpha=0.1, baza osi z 1e6 H/A, prąd 0.02 A, bias 10000 A/m.
Wyłączono exchange i demag; sprawdzano jednorodność magnetyzacji węzłów.

Artefakt `.fullmag/reports/fem-antenna-trajectories/qualification.json`
zapisano jako `recorded_unvalidated`; dopiero niezależny
`scripts/validate_fem_antenna_trajectories.py::validate` potwierdził PASS.
Source snapshot: `06056fe3da8e43902d22de1795f3c7ce6065b1a96fcb111985602d34615488ba`.
Porównanie tożsamości źródeł przed i po wykonaniu przeszło.
Maksymalny błąd wektora: 2.733153319e-6 dla przebiegów ciągłych (próg 5e-6),
9.492702013e-4 dla prostokąta (budżet 4.378217822e-3, dwa przyrosty fazy
od zboczy proporcjonalne do dt). Nie jest to dowód zbieżności obsługi zdarzeń.
Po wykonaniu zaostrzono walidator o dokładne parametry wszystkich przebiegów
i ponownie sprawdzono ten sam artefakt. Odrzucono siedem mutacji: brak
przypadku, duplikat, inną fazę, inne urządzenie, błędny wektor, inny prąd
i cofnięty czas. Ten późniejszy walidator nie należy do powyższego snapshotu.

Zakres dowodu: natywne pobranie pola antenowego przez ABI i stałokrokowa
trajektoria CPU. Prąd jest mnożony przez bazę w fixture przed ABI, więc nie
kwalifikuje to mnożenia w runnerze ani solve/projection. Zegar ma początek 0.
Pozostają retry/adaptive, niezerowy początek etapu, frozen spins/maski,
pełne składniki energii i torque, snapshot H_ant, pipeline relaksacji,
mixed mesh/PBC, zbieżność czasowa oraz GPU. T13 pozostaje otwarte.

**Zegary i przejście etapu CPU 2026-09-22:** ta sama recepta została
rozszerzona i ponownie zakończyła się kodem 0. Artefakt ma teraz schemat
`fem_antenna_trajectory.v2` oraz 60 przypadków/1260 próbek: poprzednie
20 kombinacji dla trzech wariantów zegara. Dwa nowe warianty wykonują
500 rzeczywistych kroków bias-only (0.25 ns), wywołują publiczne
`fullmag_fem_backend_begin_stage` i
`fullmag_fem_backend_reconfigure_regional_field_drives`, a następnie
kontynuują na tym samym backendzie z `absolute` albo `stage_local`.
Stan początkowy drugiego etapu jest sprawdzany względem rozwiązania
bias-only, a jego trajektoria względem całki odpowiedniego przebiegu.

Snapshot: `6584d4ec648835d8baec7a63c9c0eb4521c78150ec56f7bb369525087f04693b`;
kontrola źródeł przed/po wykonaniu przeszła. Maksymalne błędy wektora
dla nowych zegarów wyniosły 2.708e-6 (przebiegi ciągłe), 9.493e-4
(prostokąt absolute) i 6.035e-4 (prostokąt stage_local), w niezmienionych
budżetach. Celowa podmiana trajektorii sinusoidy lokalnej na absolutną
została odrzucona: błąd 0.01242 przy pierwszej próbce po granicy etapu.
Nie kompilowano unit testów Rust; wykonano naukowy program kwalifikacyjny.
Ten wynik kwalifikuje zegary i przełączenie napędu na natywnym CPU przy
stałym kroku, także dla integratorów używających FSAL. Nie zamyka jeszcze
prób adaptive/retry, pipeline z rzeczywistą relaksacją/solve, GPU ani
pozostałych warunków T13. Poprzedni raport v1 został zastąpiony raportem v2
w tym samym lokalnym katalogu; opis v1 powyżej jest zapisem historycznym.

**Adaptacyjne próby antenowe CPU 2026-09-22:** rozszerzona recepta
`just verify-fem-antenna-cpu-trajectories` zakończyła się kodem 0 dla
90 przypadków/1890 próbek. Schemat `fem_antenna_trajectory.v3` zachowuje
60 przypadków stałokrokowych i dodaje 30 adaptacyjnych: RK23/BS i RK45/DP54,
pięć przebiegów, trzy warianty zegara. Heun i RK4 nie mają pary osadzonej
i nie otrzymały sztucznej etykiety adaptive.

Konfiguracja adaptive: atol=2e-10, rtol=0, dt_min=1e-20 s,
dt_max=5e-11 s, safety=0.9, growth_limit=2, shrink_limit=0.2,
max_reject=80. Po początku etapu żądany pierwszy krok wynosi 50 ps.
Następne żądania korzystają z natywnego dt_suggested; każdy krok jest
ograniczony najbliższą chwilą zapisu. Porównanie obejmuje rzeczywiście
zaakceptowane próbki co 50 ps, z kontrolą postępu i limitu liczby kroków.

Source snapshot: `3a3db3c51f82dc114e040c7b9ee31911bfc47b596415cceab7126fd64928f3ce`;
tożsamość źródeł przed/po wykonaniu zgodna. RK23: 44712 zaakceptowanych
kroków, 126 odrzuconych prób, maksymalny błąd 6.219e-10. RK45: 2625
zaakceptowanych kroków, 108 odrzuconych prób, maksymalny błąd 1.491e-8.
Liczniki dotyczą części z aktywną anteną, bez bias-only warmup. Każdy
przypadek adaptive zawierał co najmniej jedną odrzuconą próbę. Dla wszystkich
przebiegów adaptive, również pulse, zastosowano próg wektora 5e-6.
Walidator wymaga dowodu retry dla obu integratorów; raport z wyzerowanymi
licznikami odrzuceń został odrzucony. Bieżący lokalny raport v3 zastępuje v2.

Jest to dowód trajektorii z retry i obu zegarów przez natywne CPU ABI dla
opisanych warunków. Nie jest to pełny test zbieżności, izolowany dowód
niezmienności każdego bufora po odrzuceniu ani kwalifikacja runnerowego
solve/relax/run, GPU, energii/torque i snapshotów H_ant. T13 pozostaje otwarte.

**Pola, energia i torque w zaakceptowanej chwili CPU 2026-09-22:**
`just verify-fem-antenna-cpu-trajectories` zakończyła się kodem 0 ze schematem
`fem_antenna_trajectory.v4`. Zachowano 90 przypadków i 1890 próbek trajektorii;
1800 próbek po krokach rozszerzono o `H_eff`, `H_drive`, wektor `torque`,
energię napędu, energię zewnętrznego biasu, energię całkowitą i `max_torque_Apm`.
Snapshot źródeł:
`14355474149aba5b74c56fd75a5e8c8e020cd1fdd65f5998dc8e152af3f5052b`;
porównanie źródeł przed/po wykonaniu przeszło. Raport v4 zastępuje lokalny v3.

`backends/fem/tests/llg_time_domain_qualification.cpp::write_antenna_endpoint`
kopiuje pola przez ABI i zapisuje statystyki zwrócone przez zaakceptowany krok.
Nie wywołuje odświeżającego `snapshot_stats`; `H_eff` i torque są pobierane
przed materializacją `H_drive`, aby nie maskować nieaktualnego cache.
Sprawdzana jest również jednorodność pól i torque we wszystkich węzłach.
`scripts/validate_fem_antenna_trajectories.py::validate_endpoint` niezależnie
oblicza wartość waveformu w zapisanej chwili, sumę z biasem, energię Zeemana
na objętości pojedynczego tetraedru oraz torque z zapisanej magnetyzacji.
Obowiązują bezwzględne progi: pola i `max_torque_Apm` — $10^{-7}\,\mathrm{A/m}$,
wektor torque — $10^{-12}\,\mathrm{T}$, energie — $10^{-30}\,\mathrm{J}$.
Wektor natywnego torque jest wielkością w teslach, bez mnożnika
giromagnetycznego; nie jest bezpośrednio pochodną magnetyzacji.

Odrzucono siedem niezależnych mutacji raportu: podstawienie każdej z tych
siedmiu obserwabli z poprzedniej próbki sinusoidy `stage_local` w próbie
adaptacyjnej. Nie kompilowano testów jednostkowych Rust. Zmiana rozszerza
bramkę naukową, nie zmienia równań ani implementacji solvera.

Zakres: jednorodny macrospin, jeden napęd preprojected, FEM CPU FP64.
`H_drive` sumuje regionalne napędy; tutaj odpowiada jednej antenie. Nie jest
to kwalifikacja natywnego `H_ant` per źródło, zapisu przez publiczny pipeline
artefaktów ani airboxu. Całkowita energia fixture zawiera wyłącznie bias i
napęd; pełne oddziaływania, niejednorodne siatki, solve/relax/run, mnożenie
bazy przez prąd w runnerze oraz GPU nadal wymagają osobnych dowodów.
T13 pozostaje otwarte.

**Zamrożony spin w polu anteny FEM CPU 2026-09-30:** nowa recepta
`just verify-fem-antenna-frozen-cpu` zakończyła się kodem 0. Natywny
`fem_llg_time_domain_qualification` wykonał sześć przypadków na tej samej
siatce tet4: Heun, RK4, RK23 i RK45 przy kroku stałym oraz RK23/RK45 z
adaptacją. Węzeł 0 ma referencję $\mathbf m_0=(0,1,0)$ i maskę frozen;
trzy pozostałe zaczynają od $(0.6,0,0.8)$. Wyłączono exchange/demag,
zastosowano bias $10^4\,\mathrm{A/m}$ i sinusoidalną antenę o bazie
$10^6\,\mathrm{A/(m\,A)}$, prądzie $0.02\,\mathrm A$, częstotliwości
$1\,\mathrm{GHz}$, fazie $0.7$ oraz offsecie $0.2$.

Raport `.fullmag/reports/fem-antenna-frozen/qualification.json` ma schemat
`fem_antenna_frozen.v1`, status `recorded_unvalidated` i snapshot źródeł
`b3617dc960fc17b57f8b80747c365c8959b2ffa497a4a97b65f120ca98c00eb3`.
Porównanie tożsamości źródeł przed i po wykonaniu przeszło. Niezależny
`scripts/validate_fem_antenna_frozen.py::validate` potwierdził 21 próbek na
przypadek: zamrożony spin zachował dokładnie referencję, a swobodne spiny
zgadzały się z analityczną trajektorią z całki pola (maksymalny błąd
$1.293\times10^{-6}$, próg $5\times10^{-6}$). `H_drive` na węźle frozen i
swobodnym zgadzał się z przebiegiem w zapisanym czasie do
$10^{-7}\,\mathrm{A/m}$; `max_torque_Apm` odpowiadał wyłącznie swobodnym
węzłom do $10^{-7}\,\mathrm{A/m}$. Adaptacja miała 4 odrzucenia RK23 oraz
2 RK45. Walidator odrzucił celowo zmienioną magnetyzację frozen, pole,
magnetyzację swobodną i torque.

Jest to dowód natywnego CPU dla pojedynczej maski frozen i jednorodnego
pola preprojected. Nie sprawdza jeszcze węzłów niemagnetycznych na siatce
mieszanej, okresowych ograniczeń, pełnego pipeline ani GPU. Punkt o ochronie
frozen spins i maski magnetycznej pozostaje zatem otwarty.

**Mieszana siatka magnetyk–airbox w polu anteny FEM CPU 2026-09-30:**
`just verify-fem-antenna-mixed-cpu` zakończyła się kodem 0. Dwa konforemne
tetraedry mają wspólną ścianę, markery elementów $1$ (magnetyk) i $0$
(airbox) oraz piąty węzeł należący wyłącznie do powietrza. Preprojected
basis w osi $z$ jest pełnodomenowa. Dla sinusoidy $1\,\mathrm{GHz}$,
biasu $10^4\,\mathrm{A/m}$ i kroku $0.5\,\mathrm{ps}$ wykonano po 2000
kroków Heun/RK4/RK23/RK45; zapisano po 21 próbek na integrator.

Raport `.fullmag/reports/fem-antenna-mixed/qualification.json` ma schemat
`fem_antenna_mixed.v1`, status `recorded_unvalidated` i snapshot źródeł
`ae80b1598b99f195e82d31b4ea54735686fccd2e545fe5ea47836316df5f1300`.
Tożsamość źródeł przed/po wykonaniu zgodna. Niezależny
`scripts/validate_fem_antenna_mixed.py::validate` wykazał, że `H_drive` w
airboxie i w magnetyku odpowiada waveformowi w czasie próbki do
$10^{-7}\,\mathrm{A/m}$, ale magnetyzacja węzła airboxu nie zmienia się.
Swobodne węzły magnetyku odpowiadają analitycznej trajektorii macrospinu
(maksymalny błąd $1.293\times10^{-6}$ przy progu $5\times10^{-6}$).
Metryka `max_torque_Apm` pomija węzeł airboxu mimo jego niezerowego pola.
Walidator odrzucił cztery celowe mutacje: stanu airboxu, pola w airboxie,
magnetyzacji magnetyku i torque.

Ten dowód obejmuje natywne CPU, dwa tet4, lokalny węzeł airboxu oraz stały
krok. Nie obejmuje PBC, bardziej złożonej wspólnej siatki, projekcji z
rzeczywistego solve anteny, publicznych snapshotów ani GPU. Zatem oba
podpunkty T13 o mixed-mesh i ochronie maski pozostają otwarte w szerszym
zakresie.

**Algebraiczna para PBC na mieszanej siatce CPU 2026-09-30:**
`just verify-fem-antenna-mixed-pbc-cpu` zakończyła się kodem 0.
Na tej samej siatce tet4 para magnetycznych węzłów $(1,2)$ jest jawnie
związana przez natywny `periodic_node_pairs`. Ścieżka exchange pozostaje
włączona zgodnie z kontraktem PBC, a jej współczynnik ustawiono na zero,
aby zachować niezależny analityczny wzorzec Zeemana. Cztery integratory
Heun/RK4/RK23/RK45 wykonały po 2000 kroków; pola i magnetyzacje węzłów
pary były identyczne. Natywny preflight odrzucił drugą próbę utworzenia
backendu po zwiększeniu jednej składowej bazy pola pary o
$1\,\mathrm{A/m}$; nie uśredniał niezgodnych wartości.

Raport `.fullmag/reports/fem-antenna-mixed-pbc/qualification.json` ma
schemat `fem_antenna_mixed_pbc.v1`, snapshot
`8db6de990e936ce7e221766ba39dfc25f5c97fd99dd75861b987e2bf8c4e101e`.
Porównanie źródeł przed/po i niezależny walidator przeszły; walidator
odrzucił też raport z usuniętym dowodem negatywnego preflight. Po zmianie
tego samego kodu ponownie przeszła recepta bez PBC. Wynik dotyczy
algebraicznej pary na małej siatce i stałego kroku CPU; nie jest
benchmarkiem fizycznej komórki periodycznej, demag PBC, GPU ani publicznej
projekcji bazy anteny.

## T14. Domknąć OpenAPI, zasoby i realtime

### Checkpoint 2026-10-04 — jawny wybór wykonania inspekcji w T15

Domknięto **wybór konkretnego wykonania w produkcyjnym panelu inspekcji**,
z dowodem UI przy kontrolowanym API; nie jest to zamknięcie T15 ani T18.
Kontrole wykonano na HEAD `cd7332e11108861de120633b11971384de5b0e32` wraz
z zachowanym zależnym WIP. Po kontrolach zapisano niezależny commit
`d475e7f4779677339f1206d18baf7106afa00766`: wyłącznie
`scripts/verify_control_room_sources.py`, dołączenie untracked sources,
wyłączenie cache skanu i zapis tych ustawień w receipt. Ten fragment
nie zależy od niecommitowanych producentów/API/backendu anteny; ich zmiany
pozostają razem. Treść zweryfikowanych źródeł nie zmieniła się przez commit,
więc zielonych kontroli nie powtarzano tylko z powodu nowego HEAD.
Nie zmieniono fizyki, SI, Python DSL, `ProblemIR`, backendu
ani OpenAPI. Nowy wybór jest lokalną preferencją widoku, nie zasobem ani
drugim cache danych serwerowych.

`resolveInspectionRuntimeStage` zwraca wyłącznie kandydatów powiązanych
przez `antenna_solve_stage_id`. Wspólny Radix Select pokazuje dokładny
runtime ID i status. Przy wielu wykonaniach użytkownik wskazuje wynik,
bez wybierania pierwszego/ostatniego ani dopasowania po etykiecie/indeksie.
Wybór należy do `(authoredStageId, runId, sessionId, sessionEpoch,
requestScopeEpoch)`; `inspectionSelectionMatchesContext` odrzuca inny
kontekst. Panel usuwa taki wybór przed zatwierdzeniem renderu, więc run
A→B→A nie przywraca starej selekcji. Rewizja tego samego kontekstu zachowuje
wybór. Zniknięcie wskazanego ID w tym samym runie wymaga kolejnego jawnego
wyboru; nie ma fallbacku do jedynego pozostałego wyniku. Puste/zduplikowane
ID oraz brak/niewłaściwy typ run ID blokują odczyt bez wyjątku renderowania.

Pierwszy smoke wykrył regresję zachowania układu: `enabled=false` odcinało
nie tylko loader, ale także dane i subskrypcję metadanych w czasie refresh
execution. Poprawiono przyczynę przez `pauseLoad` istniejącej warstwy
resource: metadane tego samego ownera i miejsca próbek pozostają widoczne,
loader czeka na aktualne execution, a stare liczby nie są przedstawiane
jako aktualny payload. Nie osłabiono kontrolera scroll/focus. Drugi smoke
wskazał błąd synchronizacji testu klawiatury: Radix planuje przeniesienie
fokusu; teraz Enter jest wysyłany dopiero, gdy dokładna zamierzona opcja
otrzyma fokus. Wszystkie sprawdzenia runtime ID, digestu i raw H pozostały.

**Końcowy browser PASS:** 16 kontroli, 62 GET, 338 commitów Profilera
w całym wieloscenariuszowym harnessie, 19 screenshotów, zero page/console
errors i unexpected GET. Limity całego harnessu: 100 żądań i 500 renderów.
Zachowano 11 wcześniejszych scenariuszy i dodano wybór dwóch wykonań z
identyczną etykietą oraz różnymi digestami/H, refresh wybranego wyniku,
spóźnione metadata poprzedniego wyboru mimo transportu ignorującego abort,
zmianę runu przy stałej inkarnacji i powrót bez resurrection oraz wąski
Inspector/dropdown. Refresh: 4 GET, 18 renderów, `rootChanged=0`,
`maxScrollDelta=0`, zachowany fokus, zero disabled/opacity changes oraz
aktywnych opacity animations. Idle pozostaje bez polling/renderów.
Panel 310 px, selektor 298 px, czcionka 11 px, poziomy overflow 0;
obejrzano screenshot listy po zakończeniu animacji oraz obu wyborów.
To dowód rzeczywistych hooków/Inspectora/cache z fixture transportem,
**nie native HTTP, nie numerical validation, nie kwalifikacja pola**.

Interpretowany checker ma **26 grup PASS**, z zachowaniem poprzednich
17; 48 przypadków selection/context/pauseLoad uzupełnia 9 mappingu,
29 owner/run/ID, 29 odmów metadanych i 37 odmów dekodera. Nie kompilowano
testów jednostkowych. Walidatory map noty 0950 i planu oraz architecture
hygiene są osobnymi kontrolami źródeł/dokumentacji, nie dowodem runtime.

React Doctor 0.9.12 wykonano offline. Naprawiono zakres zarządzanej recepty:
`--include-untracked --no-cache`, aby objęła nowe panele WIP. Skan 40 plików
zakończył się exit 0, **z 7 ostrzeżeniami**, nie z zerową liczbą findings.
Nowy panel/model inspekcji nie ma findingów. Ostrzeżenie `window` wskazuje
pole typu `HysteresisExecutionTreeQuery.window`, nie odczyt globalu SSR;
odczyt runtime ma guard `typeof window`. Skanowanie małych dirty-key tablic
i indeksy stateless, stałych wierszy podglądu nie dowodzą awarii. Editable
station/cut keys oraz non-null assertion mesh ACK pozostają do celowanej
regresji i review przed pełnym odbiorem T15; konfiguracji reguł nie wyciszano.
Samo exit 0 nie zamyka tych pozycji ani całego workflow anteny.

Receipts pod `storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:

- Browser: `windows-control-room-browser-fixture/antenna-external-lead-inspection-browser/a1897719f14b4351b60998db256fc8d7/receipt.json`, PASS,
  niezmieniony digest `8f9c48d680424574d20a4eee2f1e533cca04e8db11590f626985b48be0d9e6d5`, owned server terminal.
- React Doctor: `windows-control-room-source-check/react-doctor/5b7e1cbefe4b4503853fdc9dba058569/receipt.json`, PASS/7 warnings.
- Checker: `windows-control-room-source-check/resource-client-cache-check/623a233a979f447e9114807d02c9c77a/receipt.json`, PASS.
- Produkcyjny TS: `windows-control-room-source-check/production-source/b008b2a34b514336a9ee77cdd9935eab/receipt.json`, PASS.
- ESLint całego frontendu: `windows-control-room-source-check/lint/3f67dd3be2794a308d746190677d8c34/receipt.json`, PASS, zero błędów/ostrzeżeń.
- Higiena API: `windows-control-room-source-check/api-hygiene/6fe1729cb2984acc91ce43d579e0ea25/receipt.json`, PASS.

Wszystkie sześć końcowych receipts wiąże ten sam digest co browser,
z niezmienionymi źródłami i exit 0. Regeneracja OpenAPI nie była potrzebna:
ten przyrost nie zmienił wire schema ani wygenerowanych plików. Poprzedni
odbiór generatora pozostaje dowodem wyłącznie dla niezmienionego kontraktu.

**Następny zakres:** nadal rzeczywisty native HTTP/UI, create→solve→inspect
na rzeczywistej scenie, field-map/quantity, qualified projection/baza na
amper, Relax/LLG/FFT, cztery realizacje i końcowy odbiór T18. Aktualizacja
wspólnego zaufanego koordynatora BuildRunnera wymaga osobnej oczekiwanej
zgody; w tej iteracji nie było deploy/restart/enqueue. Nie promować raw
`inspection_only` do `ready`, LLG, H/I ani quantity tylko na podstawie
tego smoke. Pełny cykl integracji/cleanup nie jest jeszcze zakończony.

### Checkpoint 2026-10-04 — Inspector inspekcji i jawna tożsamość wykonania

Przyrost T15 jest podłączony źródłowo i ma **dowód przeglądarkowy z
kontrolowanym API**, nie odbiór całego T15/T18. HEAD pozostaje
`cd7332e11108861de120633b11971384de5b0e32`; nowy przyrost należy do zależnego
WIP. Nie zmieniono równań, jednostek, `ProblemIR`, publicznego Python DSL
ani kwalifikacji pola.

Wykryta luka kontraktu: ID definicji solve z Explorer/SceneResource nie jest
runtime ID, a ID węzła pipeline może legalnie różnić się od obu. Nowe
opcjonalne `antenna_solve_stage_id` w rekordach CLI/API/OpenAPI pochodzi
wyłącznie z rzeczywistej akcji: `ExternalLeadInspection.input.stage.id`
albo `FieldSolve.stage_id`. Helper `attach_stage_antenna_solve_identity`
działa w pięciu publikacjach scripted i zachowuje historię terminalną.
Brak dawnego powiązania pozostaje `None`, bez rekonstrukcji po etykiecie,
indeksie, `active_stage_id` ani nazwie obiektu. Koperta wykonania zwraca
session ID, naukowy epoch, request incarnation i run ID z jednej migawki.
Kontrola źródeł producenta: **6/6 PASS**; parser siedmiu Rust plików PASS.
To nie kompilacja ani wykonanie CLI/native.

`AntennaExternalLeadInspectionPanel` jest osobną sekcją Inspectora solve.
Wymaga potwierdzonego ownera i dokładnie jednego jawnego powiązania
definicji z execution; zero oznacza brak wyniku, wiele — niejednoznaczność,
bez wyboru pierwszego/ostatniego. Metadane są dodatkowo porównywane po
run i obu ID etapu. Panel pokazuje status, `NOT VERIFIED`, field scope,
diagnostykę, port/output, rewizję i digest, sampling carrier/domain/topology,
requested/resolved execution oraz jednostki pięciu descriptorów.
Nie publikuje nowej quantity ani nie promuje inspekcji do bazy LLG.

Podgląd pobiera **dwa** digest-pinned Range, najwyżej osiem XYZ próbek:
pozycje w m oraz raw H w A/m, bez H/I, mu0, solve, LLG i FFT. Model
sprawdza manifest-only, output reference/digest, qualification/scope,
typ, layout, count/byte count, dokładny Content-Range, ETag i skończoność
float64 little-endian. Bundle, device IDs i potencjał nie są pobierane
automatycznie. Failed/cancelled, niezgodna tożsamość i błędy nie dostają
liczbowego podglądu. Podczas odświeżania tego samego ownera pozostają
metadane ze wspólnego cache oraz stabilne miejsca próbek, ale stare liczby
zastępuje jawne oczekiwanie na aktualny payload; nie dodano drugiego store.
Style są lokalnie ograniczone przez `fm-antenna-inspection`, z tokenami
`--fm-*` i import-only `globals.css`.

Interpretowany checker produkcyjnego modelu/hooks/fasady ma **23 grupy PASS**,
z zachowaniem poprzednich 17. Nowe kontrole obejmują 9 przypadków mappingu,
29 owner/run/ID/ABA, 29 odmów metadanych i 37 odmów dekodera/range/bounds.
Nie kompilowano ani nie uruchamiano unit bundles. OpenAPI i klient
zostały wygenerowane przez zarządzane recepty, bez ręcznej edycji typów.

Zarządzana recepta `verify-antenna-external-lead-inspection-browser` kopiuje
źródła do immutable widoku w storage, używa istniejących zależności oraz
Chrome i zatrzymuje wyłącznie własny Next. Dodano także ścisłe dopuszczenie
tego scenariusza w storage shell; **4/4** odmowy nieprawidłowego portu,
scenariusza, dodatkowego argumentu i komendy złożonej przeszły przed startem.
Pierwszy rzeczywisty smoke wykrył chwilowy skok bottom-scroll **22 px**.
Poprawiono przyczynę — znikający/zmieniający wysokość komunikat — bez
osłabiania testu. Końcowy smoke: **11 kontroli PASS**, 41 GET, 13 screenshotów,
zero page/console errors. Refresh: 4 GET, 9 renderów, stały root/fokus,
zero disabled/opacity changes i opacity animations, **maxScrollDelta=0**,
także bez sztucznego spaceru. Osobno sprawdzono idle oraz failed,
cancelled, authored mismatch, many mappings, stale execution owner,
stale metadata owner, brak mapowania i błąd integralności API.
Obejrzano rzeczywiste screenshoty przed/pending/po: zmieniają się wartości
na placeholdery i z powrotem, a położenie wierszy pozostaje identyczne.
Dowód dotyczy panelu/hooków i kontrolowanego transportu, nie backendu.

Receipts pod `storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:

- OpenAPI: `windows-api-source-check/api-openapi-codegen/f23ed0058b524e9da2ed4591981900a0/receipt.json`, PASS,
  niezmieniony digest `59b7d5e845ff25072351194fdc0e070f2d6946df055f3f10efb66c4253771379`.
- Klient: `windows-control-room-source-check/generate-client/51e51e2c5cbf4d2b979b486638713c62/receipt.json`, PASS.
- Końcowy TS: `windows-control-room-source-check/production-source/edcf5329298043e0bffc028aabb93493/receipt.json`, PASS.
- Końcowy checker: `windows-control-room-source-check/resource-client-cache-check/3d91c4dcc0b0463e888988fc4d2bfb5a/receipt.json`, PASS.
- Końcowa higiena API: `windows-control-room-source-check/api-hygiene/005c5abc73cc41e3b319039b58611ecb/receipt.json`, PASS.
- Końcowy ESLint całego frontendu: `windows-control-room-source-check/lint/8973711232514197b22630315647706f/receipt.json`, PASS, zero błędów/ostrzeżeń.
- Browser: `windows-control-room-browser-fixture/antenna-external-lead-inspection-browser/8dac6ec8d74743fd86a09d92e26030af/receipt.json`, PASS,
  niezmieniony digest `2669d1a286d59559b251a424959646645d7da4dd38ea4a906a006c0264fc333c`, owned server terminal potwierdzony.

Końcowe TS/checker/higiena/ESLint wiążą ten sam digest co browser, z exit 0
i niezmienionymi źródłami. Granice modułów przeszły osobną kontrolę
architecture hygiene. Focused walidatory map noty 0950 i tego planu PASS;
niezmienione zielone testy samego walidatora nie były powtarzane.

**Pozostałe bramki:** rzeczywisty HTTP/UI z nowym zaufanym pakietem native,
wybór konkretnego wykonania przy wielu mappingach, create→solve→inspect→stale
na rzeczywistej scenie, field-map/quantity, kwalifikowana projekcja/baza na
amper, Relax/LLG/FFT, cztery realizacje i końcowy odbiór T18. Osobna zgoda
na aktualizację wspólnego koordynatora BuildRunnera nadal nie została
otrzymana; nie było deploy/restart ani enqueue. Nie dzielić zależnego WIP
na commity pozbawione wymaganych producentów/tras. Stany backendowe i
checkboxy całego T15/T18 pozostają otwarte.

### Checkpoint 2026-10-04 — typowana fasada inspekcji i izolacja cache

Zrealizowano kolejny **przyrost źródeł**, nie zamknięcie T14/T15 ani całego
T00–T18. Koperty field solution, source spectrum i stage catalog otrzymały
wymagane `request_scope_epoch`, pobrane z już sprawdzonego kontekstu żądania.
Inspection miało to pole wcześniej. Artefakty, `ProblemIR`, jednostki,
podpisy fizyczne i cache przestrzennej bazy nie zostały przez to zmienione.
Wygenerowany kontrakt ma wymagane pole w **4/4** kopertach i scope/`409`
w **7/7** antenowych GET; klient został zregenerowany, nie edytowany ręcznie.

`ControlRoomApi.data.antenna` ma osobne metody metadanych i payloadu
external-lead inspection. Binary GET wymaga digestu wybranego
`inspection_ref`, używa wspólnego transportu i ogranicza body przed
dekodowaniem do 128 MiB także przy większym limicie caller'a. Zachowuje
surowe wartości SI; nie wykonuje solve, projekcji, FFT ani normalizacji H.
Wszystkie **siedem** resource hooks wiążą cache z potwierdzoną tożsamością
session/scientific epoch/request incarnation i przekazują scope z kontekstu
loadera do HTTP. Nieznany owner wyłącza odczyt. Naprawiono helpery ETag
field/spectrum, które po integracji mastera pomijały nową inkarnację.

Nowy hook payloadu inspection przyjmuje metadane wybranego wyniku:
wymaga `inspection_only`, manifestu, dokładnie jednego outputu oraz
zgodności ownera i digestu manifestu. Klucz zawiera dokładny runtime
stage ID, content digest, stage revision/record digest i Range.
`failed|cancelled`, brak manifestu i stary owner nie wyzwalają binary GET;
terminalny JSON pozostaje czytelny. `409`, `422` i `404 missing_payload`
nie są zamieniane na pusty wynik. Zwykłe metadata `404` może dać `null`.
Zmiana stage execution lub katalogu artefaktów unieważnia wspólny prefiks
stage resources, również scoped catalog/inspection/payload keys, bez
ubocznego odświeżenia topologii. Porównanie bazy/widma z katalogiem etapu
sprawdza też inkarnację sesji.

Interpretowany checker wykonuje rzeczywiste produkcyjne hooki, helpery
tożsamości/kluczy, generowane ścieżki oraz dokładny fragment fasady i
lifecycle invalidation. React scheduling i granica transportu są
kontrolowane; fixture **nie jest numerycznym bundle**. Wynik:
**17 grup PASS**, w tym 7 hooków, 5 rodzajów payloadu, 12 odmów/wyłączeń
payloadu, 25 przypadków błędów, 2 porównania ABA i 3 scoped invalidations.
Nie emitowano kodu i nie kompilowano unit bundles. Poprawiono także
istniejący regex checkera, by akceptował rzeczywisty trailing comma po
`api.resourceCacheScope` w masterowym providerze; kod providera pozostał
niezmieniony. Zapisano dodatkowe regresje Vitest dla fasady i invalidation,
ale **nie kompilowano ani nie uruchamiano** tych testów.

Wszystkie poniższe receipts mają `passed`, exit 0 i niezmienione źródła
w czasie kontrolowanej trasy, pod
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:

- OpenAPI: `windows-api-source-check/api-openapi-codegen/2af4e6ca7b724a2e9b254d0bd13f6d31/receipt.json`;
  digest produkcyjnych źródeł przed/po
  `8d7733ae082a48666f5e75c0b2548982474c42f670ee6d48709898c6862e4089`.
- Klient: `windows-control-room-source-check/generate-client/84f6eb9432c74a4189953747bca5dda2/receipt.json`.
- TypeScript production-only: `windows-control-room-source-check/production-source/164d3abe8b354d4e80c7da157e67b43e/receipt.json`.
- Interpretowany cache/facade check: `windows-control-room-source-check/resource-client-cache-check/03fdb0869a9d4258b006e0e4e1de174a/receipt.json`.
- Higiena API: `windows-control-room-source-check/api-hygiene/056bcbae45f14ab4809627a61b37817c/receipt.json`.

Trzy końcowe kontrole frontendu wiążą ten sam digest źródeł przed/po:
`0a3d5e89bd1872382bb8f615765d16e70b593cd6c53eb39d95795e5f3106adca`.
Niezależny review źródeł nie znalazł pozostałych Required findings.
Walidacja map noty 0950 i tego planu pozostaje osobną kontrolą dokumentacji.
Zależny przyrost API/klienta/hooks pozostaje WIP: nie rozdzielać go na
commity, które bez niewersjonowanych jeszcze producentów/tras nie budują
poprawnego kontraktu. Samodzielny checker HTTP ma wcześniejszy commit
`cd7332e11108861de120633b11971384de5b0e32`.

**Następna praca:** podłączyć inspection-only wynik i diagnostykę do
właściwego panelu Control Room, zweryfikować zachowanie w przeglądarce oraz
wykonać rzeczywisty HTTP smoke na bieżącym, zaufanym pakiecie native.
Osobna zgoda na aktualizację wspólnego koordynatora BuildRunnera nadal
nie została otrzymana; nie było deploy/restart ani nowego enqueue.
Po tej zgodzie obowiązuje pusty slot, hash/health, zamrożony pełny snapshot
i jawny komplet untracked. Pełne V/RT0/H, projekcja/baza na amper, LLG,
FFT, cztery realizacje backendowe i końcowe T18 pozostają **NOT VERIFIED**
w wymaganym wspólnym przepływie; receipt źródeł ani dostęp do JSON tego
nie zastępują.

### Checkpoint 2026-10-04 — izolacja odczytów anten po integracji mastera

WIP T14 nadal jest **niezamknięty**. Wszystkie siedem GET rodziny anten
wiąże teraz odczyt z kanonicznym `CurrentLiveRequestContext`, sprawdza
`x-fullmag-session-scope` przed plikami oraz ponownie przed odpowiedzią
warunkową/binarną. Inkarnacja `request_scope_epoch` uczestniczy w każdym
ETag; inspection metadata zwraca ją jawnie. Naukowy `session_epoch`
pochodzi z kanonicznego helpera statusu, również dla tombstone wynikającego
z lifecycle etapu, a nie z samego `session.status`.

Niezależny review ujawnił dodatkowy ABA: import może opublikować nową
migawkę/root, następnie awaitować zasoby UI i dopiero później zwiększyć
licznik inkarnacji. Root/refs capture i końcowy identity recheck używają
teraz kolejności `transition -> state -> ensure/atomic`, jak inne scoped
zasoby mastera. Blokady nie obejmują odczytu plików. Nie zmieniano ogólnego
helpera `validate_current_live_request_context` ani globalnej semantyki
importu. Review finalnych źródeł nie zgłosił pozostałych uwag Required
w tym zakresie; nie jest to dowód runtime.

Zapisane, **niekompilowane i niewykonane** regresje Rust obejmują:
zaakceptowany scoped baseline przed odmową starej inkarnacji na siedmiu
trasach, zmianę ETag po identycznym reopen, owner ABA oraz deterministyczny
manual poll odczytów root/identity/catalog w przerwie publikacji importu.
Fixture routera używa masterowego `build_v2_router().with_state(...)`.
Parser Rust trzech zmienionych plików oraz kontrola whitespace przeszły.

Checker HTTP jest read-only: po bootstrapie używa kanonicznego scope,
wykonuje 32 GET, w tym siedem odmów stale-scope z conditional GET/Range.
Przeszło **17/17** interpretowanych regresji Python, w tym rzeczywisty
transport loopback harnessu. Commit tego samodzielnego narzędzia i instrukcji:
`cd7332e11108861de120633b11971384de5b0e32` (trzy pliki; pozostały WIP
nie był stage'owany). Harness nie zawiera poprawnego numerycznego bundle
i nie zastępuje odczytu nowego API Fullmaga.

Końcowe dowody lekkiej trasy produkcyjnych źródeł, wszystkie `passed/exit 0`
pod `storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:

- OpenAPI: `windows-api-source-check/api-openapi-codegen/9b90235fec0f4ee88006a746cfeb0a26/receipt.json`;
  SHA źródeł przed/po
  `00b2b2a60b70cfc188cfc021a2b9c0033fd921c7a46b3cf1e1514727cbb7bb9d`.
- Klient: `windows-control-room-source-check/generate-client/8a5bacf34f2e4abea05f02ed9d815542/receipt.json`.
- Produkcyjny TypeScript, bez test/spec bundles:
  `windows-control-room-source-check/production-source/717d67af47734b81a38b8ca74903d76f/receipt.json`;
  SHA źródeł przed/po
  `5f0f83357e304a639ad795b8c979c4b611c924346919b5b8c74b1a61d09ae6a0`.
- Higiena API: `windows-control-room-source-check/api-hygiene/7d04b7e364e64918b68e9d923fcea6c6/receipt.json`.

OpenAPI ma scope header i odpowiedź `409` dla **7/7** tras oraz wymagane
`request_scope_epoch` w kopercie inspection (`allOf` dla flattened record).
Wygenerowany klient nie był edytowany ręcznie. Walidatory map noty 0950
i planu przeszły. Kontrole produkcyjnych źródeł nie kompilowały testów
jednostkowych, nie budowały FEM i nie kwalifikują fizyki ani UI.

Natywna kwalifikacja aktualnego WIP pozostaje **NOT VERIFIED**. Runner jest
zdrowy, lecz odczyt trusted koordynatora nadal wykazał `copy2`, pięć
wymaganych wyjść i brak kontroli niepustych plików. Lokalna poprawiona
wersja ma fresh-copy oraz piętnaście wymaganych wyjść. Pytanie o osobną
zgodę na aktualizację wspólnego koordynatora przy pustym slocie zostało
przekazane użytkownikowi; nie wykonano restartu/deploy ani nowego enqueue.
Po zgodzie: potwierdzić pusty slot, zaktualizować kanoniczną trasą,
sprawdzić hash i health, zamrozić źródła, przechwycić snapshot z jawnym
kompletem untracked i dopiero wtedy wykonać nowy build oraz rzeczywisty
HTTP/native smoke. Bez tej zgody można dalej domykać niezależne facade,
hooks i dokumentację, ale nie ogłaszać T14/T06/T18 jako ukończonych.

**Walidacja zasobu 2026-10-03:** oba endpointy rozwiązania pola sprawdzają
przed `304` spójność deklarowanych liczności, jednostek i układów V/J/H
z nośnikami przewodnika i próbkowania, typ/układ/liczność opcjonalnej topologii tet4
oraz status/tożsamość/podpisy, unikalność i normalizację baz portów. Regresja
API używa ponownie zahashowanego manifestu z fałszywą licznością J, jednostką
H, skalą normalizacji albo pustym `source_object_id`; kod testu
jest zapisany, ale nie został wykonany z powodu zakazu kompilacji testów
jednostkowych. Zakończony build `4204fc0ca6474de7b6c66dd6462ed217` został
przechwycony przed tą edycją i nie dowodzi jej kompilacji. Job
`1e40bb7569754c1aaec2728555021c40` (digest
`a70d50ae3808c5374110411e6486265a314cc454b85e8ab8cb555c39da4f678f`)
zawiera tę zmianę; jego receipt deklaruje `succeeded`, trzy etapy z kodem 0
i 109 artefaktów, a koordynator potwierdził terminalny status `succeeded`
z exit 0. Receipt nadal ma `qualification: NOT VERIFIED`, a testy Rust
pozostają niewykonane.
Po przechwyceniu tego joba rozszerzono odczyt payloadów o strumieniową
kontrolę skończoności `float64_le` i granic indeksów tet4, również dla
ponownie zahashowanych danych; dodane regresje źródłowe nie są objęte tym
snapshotem ani nie zostały wykonane z powodu zakazu kompilacji testów.
Build tych zmian zlecono jako job `b750de77c4224121a5273ce1472a24b6`
(digest `955fc5d991e847bdc0c9342e9b063cebb448cb752b745a2a224a35cb8cb515cb`);
koordynator potwierdził terminalny `succeeded` z exit 0. Jest to dowód
buildu, nie wykonania testów regresyjnych ani kwalifikacji naukowej.
Po tym snapshotcie API otrzymało również kontrolę unikalności ścieżek
referencji dla wszystkich portów. Regresja z dwoma portami i aliasowanymi
V/J/H jest zapisana, lecz nieuruchomiona. Snapshot obejmujący tę zmianę
zlecono jako job `8c186fd7117b4f26a7252d4bb56c13da` (digest
`4ab9c2226e54b927909a0299ecbc437d336e36ee2d5994b7f45bcae07c15ef26`);
worker zakończył pracę z exit 0, a receipt deklaruje `succeeded`,
trzy etapy z exit 0 i 109 artefaktów. Ponowny odczyt koordynatora potwierdził
terminalny status `succeeded` z exit 0. Receipt ma `qualification: NOT VERIFIED`.
Nadal brakuje
kanonicznego katalogu pól per asset/port/projekcja, browser smoke i pełnego
runtime E2E.

**Pochodzenie nośnika próbkowania 2026-10-03:** producent rozwiązania
przenosi teraz `domain`, `carrier_kind`, `location` i `topology_digest`
z `AntennaFieldSamplingPlanIR` do manifestu jako `sample_carrier`.
Sesyjny zasób API odczytuje te same typowane metadane. Producent i czytniki
odrzucają pustą domenę/rodzaj, lokalizację inną niż `node` oraz digest
niebędący kanonicznym SHA-256. Historyczny manifest bez tego pola daje
`null` w zasobie API; sam odczyt nie uprawnia do adopcji na bieżącej
siatce viewportu. Digest dotyczy pełnego `MeshIR` z planu, a nie tylko
payloadu tet4. Dopasowanie do bieżącej domeny, topologii i transformacji
pozostaje osobną bramką T14/T15.
Walidator noty 0950 i 32 testy kontraktu dokumentacji przeszły;
`rustfmt --emit stdout` potwierdził parsowanie zmienionych plików Rust,
a `git diff --check` nie zgłosił błędów. Regresje Rust są zapisane,
ale niewykonane przy obowiązującym zakazie kompilacji testów.
Snapshot zlecono jako job `2f42f7bf46464bc18bb76345de081ca1`, digest
`e51be85ca4a0739c4ac7a3ce1c1181710d60fc99735b66e3adae209097fbbddb`.
Job przeszedł do `running` i uruchomił natywną kompilację. Nowe binarium
API wyeksportowało OpenAPI; jego `source_snapshot_sha256` jest równy
`333446d57e78caacd928bba1cbe2e99946e31d04752986e167097263fb8c5781`
z capture tego joba. Surowy eksport zachowano w
`storage/runs/antenna-openapi/20261003-sample-carrier/openapi-v2.raw.json`.
Wykonano istniejącą normalizację build identity i generatory
`generate:api-v2-types` oraz `generate:api-v2-client` (exit 0).
Eksporter pochodzi z kolejki kontenerowej; nie uruchamiano hostowego
`cargo run` z bazowej recepty `generate:openapi-v2`. Wygenerowany kontrakt
zawiera `AntennaSampleCarrierResource` i nullable/optional `sample_carrier`.
Nie edytowano ręcznie wygenerowanych plików. T14 pozostaje otwarte.

**Panel pochodzenia próbek 2026-10-03:** Inspector bazy pola pokazuje teraz
domenę próbkowania, rodzaj nośnika, lokalizację oraz digest topologii.
Historyczny wynik bez metadanych jest oznaczony jako
`Unrecorded (legacy asset)`. To odczyt provenance; panel nadal wyświetla
tylko ograniczony podgląd próbek, a adopcja do viewportu pozostaje otwarta.
Verifier `browser` potwierdził 158/158 testów Node/Vitest, zero failures
i skips oraz niezmienione źródła; raport:
`storage/runs/antenna-contracts/20261003T121014535442Z-a6cd118d/result.json`.
Status całej bramki pozostaje `not_qualified`, ponieważ nie wykonano
browser E2E ani managed runtime. Ta edycja frontendu nastąpiła po capture
joba `2f42f7bf46464bc18bb76345de081ca1`; jego build jej nie obejmuje.
Po regeneracji kontraktu kontrola `pnpm --dir apps/control-room run typecheck`
przeszła z kodem 0 (`next typegen` oraz `tsc --noEmit`). Cache TypeScript
pozostaje pod rozwiązanym `storage/builds/<worktree-id>/frontend`.
Focused ESLint czterech plików `AntennaFieldBasisPreview*` przeszedł
z kodem 0 i bez ostrzeżeń. Nie zastępuje kontroli TypeScript ani dowodu
wizualnego z przeglądarki.

**Baza źródłowa a certyfikat projekcji (2026-10-03):** handler
`get_antenna_field_solution` nie nadaje już `target_projection_signature`
na podstawie tego, że mapa zadeklarowanych targetów ma jeden wpis.
Zasób nieprojektowanej bazy zwraca `null`; zachowuje natomiast mapę
zależności planowania w `signatures.target_projection_signatures`.
Certyfikat rzeczywistej projekcji musi wiązać topologię i transformację
targetu, mapowanie, maskę oraz metodę projekcji; sam fingerprint intencji
autorskiej nim nie jest. Dodano regresję źródłową z jednym targetem.
Nie została wykonana przy zakazie kompilacji testów Rust, a ta poprawka
powstała po capture joba `2f42f7bf46464bc18bb76345de081ca1`.
Walidator noty 0950 i 32 testy kontraktu dokumentacji przeszły.

**Spójność normalizacji czytników (2026-10-03):** runner wymaga teraz
`measured_positive_terminal_current_a` i `normalization_scale`, które
producent publikował od początku schematu v1. Każde z trzech miejsc
deserializacji waliduje wszystkie porty: skończony dodatni prąd,
normalizację do 1 A i dokładną odwrotną skalę, bez ponownego skalowania
payloadów. Regresja źródłowa obejmuje błędne wartości i brak metadanych
w niewybranym porcie, po ponownym obliczeniu digestu manifestu.
Poprawka powstała po capture bieżącego joba; test Rust pozostaje
niewykonany przy zakazie kompilacji testów.
Snapshot obejmujący tę poprawkę, brak pozornego certyfikatu projekcji,
panel pochodzenia próbek i wygenerowany kontrakt API zlecono jako job
`4842951a463d49739094156b30fb5af2`, capsule digest
`a5834c49aed16d0fa67d26403fab97f743122cee7d781e9e6420e857af123576`,
native source identity
`5eb1c85cf62383aad1827c2af5f5e67273a54be8c74eeee19ad7df1de64a223b`.
Koordynator potwierdził `queued`; nie jest to jeszcze dowód kompilacji.
Opis blokady wspólnego V/J/H w T06 jest w tym capture, ale jej implementacja
nie jest naprawiona. Kolejny build nie może być użyty do kwalifikacji T06.
Kontrola `check:api-hygiene` nie przeszła z powodu literalnych ścieżek v2
w dwóch niezmienionych testach viewportu (`viewport3dResources.test.ts`
i `useViewport3DSceneModel.test.ts`). Nie zmieniano tych testów w tym zadaniu.

**Decyzja integracyjna katalogu pól (2026-10-03):** obecne `H_ant` w
kanonicznym katalogu quantity oznacza chwilowe, zsumowane pole wzbudzające
na bieżącej domenie; nie identyfikuje konkretnego opublikowanego rozwiązania
anteny. Natomiast `H_ant_basis` z manifestu rozwiązania jest bazą przestrzenną
jednego portu na 1 A, w jednostce `(A/m)/A`. Nie wolno wystawić tej bazy jako
chwilowego `H_ant` ani nazwać jej `b_zeeman_antena_1` bez mnożenia przez
zadany prąd i, dla indukcji, przez `mu0`. Widoczny alias anteny może być
etykietą UI, lecz nie może być identyfikatorem fizycznej quantity.

Domknięcie wymaga jednej kanonicznej pary katalog/payload (bez równoległej
listy w Inspectorze): identity co najmniej
`(session_generation, solution_id, source_object_id, port_mode_id,
target_projection_signature, carrier_id, quantity_id, component, time_ref)`.
`time_ref` jest nieobecny dla nieruchomej bazy per ampere; dla pola chwilowego
oznacza czas i origin waveformu, nie aktualną godzinę UI. Deskryptor katalogu
może mieć wiele instancji tej samej quantity na różnych assetach/portach;
obecne `FieldCatalog.quantities` indeksowane wyłącznie przez `quantity_id`
nie spełnia tego warunku. Rozszerzyć wspólny deskryptor/nośnik oraz query
wektorowego zasobu, zamiast tworzyć nazwę quantity z numeru anteny.

Warianty wyświetlenia trzeba odróżnić w metadanych i jednostkach:
`H_ant_basis` (`(A/m)/A`, pole na 1 A), `H_ant` (`A/m`, pole po przemnożeniu
przez prąd dla danego czasu) oraz `B_zeeman_ant` (`T`, `mu0 * H_ant`).
Pole na przewodniku lub airboxie wolno publikować tylko na zgodnym nośniku;
pole na obiekcie magnetycznym wymaga zweryfikowanej projekcji na jego węzły
lub komórki. Brak projekcji lub niezgodny fingerprint mają dawać stan
`unavailable/stale`, nie cichą interpolację ani pole z obcej siatki.

Regresje T14 mają obejmować dwa assety z tym samym `quantity_id`, dwa porty
jednego assetu, zmianę generacji sesji, zmianę podpisu projekcji, zmianę
czasu/waveform origin, konwersję `mu0`, nośnik obiektu i airboxa, ETag/304
po uszkodzeniu payloadu oraz scoped invalidation. Browser smoke ma wykazać,
że wybór anteny i komponentu wyświetla poprawny carrier, jednostkę i
próbki we wspólnym viewportcie. Sama trasa `field-solutions/.../payloads`
ani obecny `H_ant` nie zamykają tego wymagania.

Uzupełnienie implementacyjne 2026-10-03 (binarne pole rozwiązania): dodano
sesyjną trasę `field-solutions/{solution_id}/payloads/{payload_kind}` dla
pozycji przewodnika/próbek, opcjonalnej topologii oraz V/J/H wybranego portu.
Trasa przed odpowiedzią lub `304` sprawdza digest manifestu, obecność,
rozmiar i SHA-256 wszystkich referencji; żądany bufor sprawdza ponownie
po odczycie. Wspiera silny ETag i zakres bajtowy. Wygenerowano OpenAPI oraz
podłączono typowaną fasadę i hook z kluczem rewizji; dwa celowane zestawy
frontendowe przeszły **139/139**, a typecheck przeszedł. Test routera
obejmuje H per port, pozycje, `206`, `304`, brak portu i korupcję przed
warunkowym odczytem, lecz pozostaje nieuruchomiony z powodu zakazu budowy
testów Rust. Pełny lint i `check:api-hygiene` są czerwone z powodów poza
tym zakresem (odpowiednio wcześniejsze błędy `FdmCuboidLayer` i literały
endpointów w testach viewportu); celowany ESLint zmienionych plików
przeszedł. Nadal brakuje połączenia bazy z kanonicznym field catalog,
wizualizacji per-antenna i browser/runtime smoke.

Uzupełnienie źródłowe 2026-10-02 (integralność metadanych widma):
`GET .../source-spectra/{output_id}` przed zwróceniem zasobu weryfikuje teraz
nie tylko obecność czterech binarnych payloadów v2, lecz także ich oczekiwany
rozmiar i SHA-256. Haszowanie jest strumieniowe (bufor 64 KiB), więc cienka
odpowiedź JSON nie wczytuje całego widma do pamięci. Dodano regresję dla
pliku o prawidłowym rozmiarze i zmienionych bajtach oraz dla pliku uciętego.
Endpoint pojedynczego payloadu weryfikuje teraz także pozostałe trzy pliki
widma przed odpowiedzią (również przed warunkowym `304`); żądany payload
sprawdza przy odczycie, bez podwójnego haszowania największego pliku.
Regresja źródłowa psuje `power` i żąda niezmienionego `amplitudes_re_im`
z `If-None-Match`: oczekuje błędu integralności, nie `304`.
Diagnostyczne `cargo check --locked -p fullmag-api` zakończyło się kodem 0;
test routera pozostaje nieuruchomiony przez zakaz testów jednostkowych.
Odczyt metadanych v2 i endpoint czterech payloadów używają teraz tego samego walidatora semantycznego co
publikacja: liczności osi/komponentów, jednostek, ścieżek binarnych oraz
przeliczonych metryk okna. Fixture API urealniono do poprawnego widma 2×2;
regresja obu tras odrzuca manifest z fałszywym gainem lub jednostką nawet po ponownym
obliczeniu digestu.
Wspólny walidator sprawdza także spójność `solution_id/source_object_id/port_mode_id`
między manifestem a sampling, parę transform/wykonana realizacja Fouriera,
konwencję fazy i fizyczny początek lokalnych osi; rehash fałszywej konwencji
jest odrzucany zarówno przy publikacji, jak i przez obie trasy API.
Walidator odrzuca również ponownie zahashowany manifest z nieortogonalną lub
niejednostkową ramą próbkowania, pustym nośnikiem/mapowaniem, pustą osią k albo
licznością binów structured FFT niezgodną z licznością próbek. Regresje są
zapisane, lecz pozostają nieuruchomione przez zakaz testów jednostkowych.
Odmowa obejmuje również deklarację `fdm_trilinear` z realizacją nośnika FEM,
bo producent widma akceptuje na razie wyłącznie `fem_element`; regresja
ponownie hashuje tak podmieniony manifest.
Testu jednostkowego nie uruchomiono z powodu zakazu w `AGENTS.md`; pełny
browser/API smoke i niezmienność zasobu przy wyścigach nadal są otwarte.
Lokalny `Fullmag_build_runner` zgłosił brak konfiguracji kontenera po
usunięciu odziedziczonego, niezgodnego `CARGO_TARGET_DIR`; nie uruchomiono
zastępczego pełnego builda poza kolejką. Zmiana API pozostaje bez dowodu
kompilacji z tej trasy.

Uzupełnienie źródłowe 2026-10-02 (zasób rozwiązania pola): analogiczna
strumieniowa walidacja obejmuje teraz wszystkie referencje binarne manifestu
`antenna_field_solution.v1` — nośniki, opcjonalną topologię i każdy port.
GET z poprzednim ETag nie może odpowiedzieć 304, gdy plik został ucięty lub
usunięty; istniejący test routera otrzymał realne payloady i regresje obu
stanów. Przy wielu podpisach projekcji zasób nie wybiera arbitralnie
pierwszego `target_projection_signature`; zwraca `null` i zachowuje pełną mapę
w `signatures`. Regresja jest nieuruchomiona z powodu zakazu testów, a pełny
build nadal nie ma dostępnej skonfigurowanej trasy runnera.

Uzupełnienie źródłowe 2026-10-02 (ETag reprezentacji): ETag metadanych
katalogu etapu, rozwiązania pola i widma źródłowego jest teraz hashem
serializowanego zasobu JSON, a nie tylko deklarowanego `content_digest`.
Zmiana rewizji etapu lub metadanych starszego widma v1 nie może więc zwrócić
304 przy niezmienionym digestcie manifestu. Bieżące manifesty rozwiązania pola
i widma v2 mają dodatkowo weryfikowany kanoniczny `content_digest` bez samego
pola digest: próba podmiany założeń albo parametrów widma przy pozostawieniu
starego digestu kończy się błędem integralności, a nie nowym 200.
Dodano regresje tych trzech zachowań; pozostają nieuruchomione przez zakaz
testów. To nie zastępuje pełnej walidacji świeżości wobec
bieżącego `ProblemIR` ani browser smoke.

Uzupełnienie implementacyjne 2026-09-21: `SolvedAntennaDriveResource` ma
teraz jawny, opcjonalny `AntennaWaveformBandwidthDeclarationResource` z
`f_max_hz`; `generate:api` odtworzył OpenAPI v2 i wygenerowane typy bez ręcznej
edycji. Ten sam przebieg uzupełnił w generated contract odpowiedzi 422 dla
nieobsługiwanej topologii widma. `check:api-hygiene` nadal zatrzymuje się na
wcześniejszych literalnych URL-ach w testach viewportu, niezwiązanych z
anteną.

Uzupełnienie implementacyjne 2026-09-21 (stage output API): dodano
`GET /v2/sessions/current/data/antenna/stages/{stage_id}/output-catalog`.
Handler wiąże stage z aktualnym read-modelem, rozwiązuje bezpiecznie jego
`artifact_ref`, waliduje `stage_output_catalog.v1` oraz istnienie manifestów,
publikuje thin metadata z tożsamością sesji/stage, digestem i ETag/304. Facade
`ControlRoomApi`, hook `useAntennaStageOutputCatalogResource` i wygenerowane
artefakty OpenAPI są podłączone. Katalog jest unieważniany scoped przy zmianie
artefaktów i przy zmianie `simulation/stages/execution`; testy klienta (135/135)
i bridge (61/61) przechodzą. Nadal pozostaje pełny resolver symbolicznego
stage/output oraz browser smoke.

**Stan 2026-09-11:** dodano typowane endpointy metadanych opublikowanego rozwiązania pola i widma źródłowego anteny (`data/antenna/...`) z tożsamością sesji, podpisami, linkami do artefaktów oraz ETag/304. Facade `ControlRoomApi` i hooki zasobów są podłączone; wcześniej wygenerowane pliki OpenAPI/TypeScript obejmują podstawowy endpoint, ale nie odzwierciedlają jeszcze dodanej odpowiedzi `unsupported_topology` HTTP 422, ponieważ generator został zablokowany limitem użycia. Zmiana katalogu artefaktów unieważnia teraz tylko prefiksy zasobów wyników anteny; test bridge obejmuje tę izolację. Router ma fixture test gotowego pola/widma, 304, 404 i uszkodzonego manifestu (`db52f48cd0e0449784f1dde51e017c8755ccc4b0`). W `973ac36da63e2e3c45c33d979c24f24ce15c5c1a` dodano manifest `antenna_source_spectrum_artifact.v2`, cztery adresowane hashem payloady `float64_le` oraz endpoint zakresowy `.../payloads/{payload_kind}` z walidacją rozmiaru/hash, ETag/304 i HTTP Range 206; facade/hook oraz testy Rust/UI obejmują ten transport. UI rozróżnia teraz brak opublikowanego payloadu (`missing_payload`) od nieobsługiwanej topologii. Pozostają pełna walidacja świeżości, odświeżenie generated OpenAPI po odzyskaniu generatora i testy przeglądarkowe end-to-end.

**Pliki:** API schema/router handlers wskazane w mapie, nowe `handlers/data/antenna.rs`, `ControlRoomApi.ts`, nowe `antennaResources.ts`, generated transport/types/paths.

- [ ] Regenerować scenę z typowanych danych T03; pole błędnie nazwane lub nieznane ma być wykrywane w authoring contract. Nie usztywniać przypadkowo unrelated extension fields bez migracji.
- [ ] Wykorzystać istniejące rodziny `simulation/stages/execution`, `data/artifacts`, `data/fields` i analysis; nowy handler dostarcza metadane rozwiązania anteny jako zasobu, nie jako stanu Inspectora.
- [ ] Zdefiniować thin metadata: IDs, status, signatures/revisions, requested/resolved lane, port summaries, warning IDs, links do payloadów. V/J/H/topology muszą pozostać binarne.
- [ ] Zapewnić resource identity co najmniej `(session_generation, asset_id, field_signature, target_projection_signature, quantity, component)`; stary ACK po zmianie generation nie może podmienić nowego wyniku.
- [ ] Zdarzenia websocket invalidują konkretne zasoby; GET/ETag/304 odtwarzają stan. Nie tworzyć ws-only kanału wyników ani poll całej sesji.
- [ ] Wygenerować wszystkie cztery artefakty kontraktu przez istniejący `generate:api`, z build/cache ustawionym zewnętrznie w T01. Nie ręcznie edytować generated TypeScript.
- [ ] Dodać methods facade i hooks zgodnie z `fieldDriveResources.ts`/ResourceCache; komponenty nie konstruują URL ani `fetch`.
- [ ] Testy: GET gotowego i stale zasobu, 304, brak/korupcja payloadu, anulowany stage, unsupported lane, scoped projection, invalidation tylko właściwego resource i odzyskanie po reconnect.

Istniejące polecenia frontendu:

```text
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room check:architecture-hygiene
```

Ich przygotowanie zależności i Cargo pozostaje zarządzane przez środowisko T01; nie kierować pnpm store ani target do repo. **Bramka:** `authoring` oraz testy API/facade/resource w `browser`. Commit: `feat: expose typed antenna solution resources`.

## T15. Zbudować spójne UI i naprawić utratę parametrów/draftu

**Przyrost 2026-10-08 — kreator CPW:** dodano kanoniczną komendę tworzenia
trzech przewodników, terminali, current module i portu oraz oba wejścia wstążki.
Podsumowanie przewodnika obejmuje wszystkie pięć wymiarów stacji CPW.
Dowody, korekta kontraktu targetów i granice odbioru:
[checkpoint kreatora CPW](2026-10-08-antenna-cpw-creator-checkpoint.md).
Nie zamyka T04/T15 ani brakujących bramek current→field→LLG/FFT.

**Przyrost 2026-10-08 — podgląd CPW WebGL:** produkcyjna warstwa primitive
przeszła Chrome smoke: widoczny canvas, aktywny WebGL, złote piksele,
odstęp nad/pod targetem i cleanup śledzonych geometrii. Pełne dowody i granice:
[checkpoint CPW WebGL](2026-10-08-antenna-cpw-webgl-checkpoint.md).
To render fixture, nie API/ACK ani native solve; T04/T15 pozostają otwarte.

**Przyrost 2026-10-08 — stacje CPW:** istniejący edytor obsługuje pięć
wymiarów przekroju CPW, zachowując transakcje, parametry i nowsze szkice po ACK.
Model: 4 interpretowane kontrole PASS; browser microstrip/CPW: 19/19 PASS.
Pełne dowody i granice w [checkpointcie edytora CPW](2026-10-08-antenna-cpw-station-editor-checkpoint.md).
To authoring z kontrolowanym transportem, nie native solve ani zamknięcie T15.

### Checkpoint 2026-10-08 — kontrakt próbkowania widma Python

[Checkpoint zakresu i eksportu FFT](2026-10-08-antenna-spectrum-sampling-checkpoint.md):
naprawiono akceptację liczności powyżej kanonicznego u32; RED/GREEN 3/3 testy
i 16 kombinacji round-trip żądania. Authoring/export etapów: 23/23 PASS.
Nie jest to kwalifikacja numeryczna FFT ani UI; pełny T15 pozostaje otwarty.

### Checkpoint 2026-10-05 — czytnik dokładnej rewizji T06

Naprawiono `tests/antenna/verify_field_convergence.py::read_solution` i
`read_vectors`: jawny legacy/revision layout, zgodność solution/asset identity,
mapowanie logicznych refs wyłącznie do katalogu wskazanego manifestu, brak
fallbacku, odmowy traversal/obcych refs/linków i zachowana integralność payloadów.
Nowa stała lekka trasa `scripts/verify_antenna_field_reader.py::run` zapisuje
managed receipts. Nie kompiluje testów ani nie wykonuje natywnej fizyki.

RED odtworzony; GREEN: 13 testów, 12 PASS i 1 real symlink SKIP (`WinError 1314`).
Nie kwalifikuje to T06 naukowo ani T09/T12/T16/T18, LLG, Relax i FFT.
Pełny kontrakt, immutable receipts, digest, review oraz ograniczenia znajdują się
w [checkpoincie czytnika](2026-10-05-antenna-field-reader-checkpoint.md).
Przyrost reader/tests/helper/checkpoint zapisano w
`16256098b34d430a211ddc8fbee28d14282f892c`; główny plan pozostaje częścią
zachowanego, zależnego WIP i nie został dołączony w całości do tego commitu.
Opis „naprawić czytnik” w wcześniejszym checkpoincie poniżej jest historyczny;
następna bramka wymaga rzeczywistych pól z trzech solve, nie syntetycznego fixture.

### Checkpoint 2026-10-05 — integracja mastera, ponowna kontrola i granica Windows/FEM

Pobrano `origin/master` `056d4f50d10389be83a68b9941d2fbcdcb8fc072`
i scalono go w `f64175e2b377654f6e2c9aa9720b9bba747fcc11`.
Zachowano wszystkie 187 plików wcześniejszego WIP (139 tracked/48 untracked)
oraz kopię Git `6b0e1b42dc0fad3367f000a872d36d434d2afa1c`.
Nie pozostawiono konfliktów. Zachowano oba moduły IR i oba zestawy scenariuszy
przeglądarkowych; master nie zastąpił authoringu anten.

Produkcyjny TypeScript ujawnił cztery błędy odziedziczone z mastera:
`apps/control-room/src/modules/start/model/aboutFullmag.ts::ExtendedAuthor`
nie deklarował `institution`, choć dane i `AboutSection` go używały.
Jednoliniową korektę zapisano w osobnym commicie
`989c332d6b45319cc5910d6653387257b58571e8`. Nie zmienia ona zachowania UI.
RED: receipt `production-source/e35de347b54948219d40bfe868806e55`, exit 2.
GREEN: `production-source/28f705060fed47ca98b62c26fd6efd38`, exit 0.
Pełne ścieżki receipts są pod profilem `windows-control-room-source-check`
w zarejestrowanym storage tego worktree. Test targets wykluczono z noEmit.

Ponownie wykonano rzeczywistą regresję Chrome przez
`just verify-antenna-transport-drafts-browser`: receipt
`antenna-transport-drafts-browser/af13c94a9c27489aa892dd5178b6720d`
pod profilem `windows-control-room-browser-fixture` ma `passed`, exit 0,
20 zaliczonych grup i 31 screenshotów, brak błędów strony/konsoli oraz
potwierdzone zamknięcie własnego serwera. TS i browser mają identyczny digest
frontendu `7ab11b808fed8c55f9c8a8bf2885e13b935b9c97960f5277806d7518f7a78c74`
przed/po; commit korekty typu nie zmienił tych bajtów źródeł.
To nadal kontrolowane HTTP i produkcyjny authoring, nie wykonanie solwera.

Zatwierdzona recepta `just windows-workspace-build dev dev 3197 auto`
przeszła resolver/preflight i przygotowanie Python w storage na D:,
ale zakończyła się **przed kompilacją**: brak SDK nightly Windows/MSVC.
`scripts/windows/run_fullmag.ps1::Ensure-NativeRustToolchain` wymaga tego SDK.
Terminalny `windows-native-fdm-cpu-dev/build-status.json` ma `failed`, exit 1,
koniec `2026-10-04T23:37:29.478988+00:00`. Nie powstał kwalifikowany pakiet.
Zgoda na przygotowanie SDK w zarządzanym storage jest oczekiwana;
nie zmieniono domyślnego toolchaina ani nie instalowano SDK na C:.

**Nie wolno zastąpić precompute anteny FDM-em.**
`crates/fullmag-plan/src/antenna_field_solve.rs::plan_antenna_field_solve_execution`
wymaga jawnego FEM, a
`crates/fullmag-runner/src/lib.rs::execute_antenna_field_solve_plan`
bez feature `fem-gpu` odrzuca wykonanie. Nazwa feature nie jest dowodem
wykonania na GPU. Windows CPU package może sprawdzać konsumpcję już istniejącej
bazy przez `CpuReference`, lecz nie kwalifikuje solve przewodnika.
`scripts/verify_antenna_contracts.py::main` nadal nie mapuje grupy `fdm-cpu`
na kwalifikowany executable. Trasa FEM i decyzja o wspólnym BuildRunnerze
pozostają odrębne; nie wykonano deploy, restartu ani nowego joba FEM.

**Następne konkretne prace T06/T09/T12/T16:**

- Naprawić czytnik `tests/antenna/verify_field_convergence.py::read_solution`:
  obecne `manifest_path.parents[3]` odpowiada legacy flat layout, nie publikacji
  `antenna/field_solutions/<solution>/<asset_id>/manifest.v1.json` przez
  `crates/fullmag-runner/src/antenna_stage.rs::publish_antenna_field_solution_atomically`.
  Zachować logiczne refs, przypisać je do dokładnej fizycznej rewizji i sprawdzić
  hashe; nie wyszukiwać dowolnego payloadu ani nie spadać do starszej rewizji.
- Zreprodukować runtime ryzyko utraty bazy przy rekonstrukcji podglądu:
  `InteractiveRuntimeHost::ensure_base_runtime_ready` wywołuje planowanie z IR,
  a `snapshot_problem_vector_fields` również replanuje bez kontekstu artefaktów.
  Plan FDM inicjalizuje `solved_antenna_drive_bases` jako pustą tablicę.
  Jest to ustalenie źródłowe, **nie potwierdzony błąd runtime**. Zachować poprawną
  retained-runtime ścieżkę `compute_current_fields`; przekazywać przygotowany
  plan i zweryfikowaną bazę przez granice rekonstrukcji, bez nowego source solve.
- Bramka konsumenta: rzeczywisty import zgodnej bazy → `compute_fields` bez LLG,
  bez zmiany czasu i magnetyzacji → binarny `H_ant`; następnie sinusoidalny Run
  z tym samym assetem. Wymaga source/target/projection identity oraz aktualności
  zależności, nie tylko zgodności liczby próbek. Syntetyczny fixture skalowania
  nie może zastąpić kwalifikacji fizycznego pola przewodnika.

Cały T00–T18 pozostaje aktywny. Ten checkpoint nie zamyka T15/T16/T18,
parytetu urządzeń, Relax/LLG/FFT ani integracji PR. Nowe wyniki dotyczą
zintegrowanych źródeł; starszych receipts nie przenosi się automatycznie.

### Checkpoint 2026-10-05 — Delete, dokładna rewizja i odtworzenie celu

Kolejny przyrost T15 dotyczy usuwania transportu w
`apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx`
→ `TransportAuthoringInspector` / `remove`. Jest to transakcja authoringu,
**nie solve ani odbiór T15/T18**. Nie zmieniono schematu, OpenAPI, Python,
`ProblemIR`, równań, SI ani kwalifikacji FDM CPU/GPU i FEM CPU/GPU.

Rzeczywisty RED `05738dbc428d4905a39350c66c89f846` zaliczył wcześniejsze
15 grup, a następnie odtworzył błąd usuwania: lista formularza miała
rewizję 1, produkcyjny `AuthoringHistoryController` odczytał scenę rewizji 2,
a panel wysłał DELETE z `base_revision=2`, przyjmując niewidziany przez
użytkownika stan. Brak błędów strony/konsoli i nieoczekiwanych żądań;
źródła niezmienne, własny serwer zamknięty. To błąd semantyki transakcji,
nie awaria natywnej fizyki.

`remove` zapamiętuje teraz dokładną rewizję widocznej listy. Nowsza rewizja
przygotowania historii powoduje lokalny 409 **przed DELETE**; zmiana celu
lub generacji przed wysłaniem również odmawia operacji. Wysłane DELETE ma
wyłącznie `base_revision=submittedRevision`; nie adaptuje nowszej bazy.
Rzeczywisty HTTP409 zachowuje szkic, ustawia scoped konflikt i refetchuje
listę. Dopiero jawny, niezapisujący Rebase Draft oraz kolejny świadomy
Delete mogą ponowić operację. Nie ma automatycznego retry.

ACK publikuje `commit.committed_scene` do obserwowanego cache właściwego
client/session scope, następnie invaliduje transport i physics graph.
`commit.resource` w odpowiedzi DELETE oznacza **usunięty** rekord; nie
jest ponownie publikowany jako obecny. Lokalny generation guard działa
dopiero po kanonicznej publikacji: spóźniony ACK nie ukrywa prawdziwej
zmiany serwera, ale nie resetuje szkicu ani nie przyznaje sukcesu nowej
generacji formularza.

Znacznik Delete ACK to lokalne metadata transakcji: key, generation,
revision, nie kopia kanonicznego zasobu. Stary/held GET nie wznawia
mutacji. Gotowa autorytatywna lista bez ID daje missing target; ostatnia
baza i lokalny tekst pozostają widoczne, bez podstawienia defaultów,
walidacji Replace brakującego ID ani niejawnego Create. Panel lokalnego
wyboru również nie wybiera sam innego zasobu; New jest akcją użytkownika.
Nowsza ready-list zawierająca odtworzony ID zastępuje znacznik ACK;
uzgodnienie draftu stosuje zwykłe reguły porównania/rebase. To zapobiega
trwałej blokadzie fixed-ID Inspectora po odtworzeniu zasobu. Regresja
symuluje zewnętrzne odtworzenie rekordu; **nie wykonuje pełnej akcji Undo**.

Pierwsza próba GREEN `06c7700f06dd4b5a9e2823eefa1db610` zaliczyła dwa
nowe scenariusze rewizji/409, ale pomiar scrolla obejmował przewinięcie
wykonane przez Playwright `fill`, ponieważ fokus był wcześniej ustawiony
na niewidocznym input przy `preventScroll`. Screenshoty 24/25/26
rozróżniają zmianę podczas interakcji testu od niezmienionego układu ACK.
Ustawiono widoczny input **przed** capture i zachowano asercję delta 0;
nie podniesiono tolerancji. Niezależny review wykrył także potrzebę
wersjonowania znacznika usunięcia, pokrytą odrębnym scenariuszem restore.

**Browser GREEN:** `af7baf0e070f4fea91003fcf58ae1873`, **20 grup**, 31
screenshotów, bez niezaliczonych asercji, błędów strony/konsoli ani
nieoczekiwanych żądań. Odrębne przebiegi: existing 38 żądań/141 renderów;
create/scope 18/89; Delete z history/409 i restore 19/65; late Delete
A→New→A 10/39. Przed restore sam Delete/idle: 16 żądań/57 renderów.
Stable root/input/fokus, selection `[1,3]`, scroll delta 0, brak zmiany
disabled/opacity kontrolki niezwiązanej oraz brak animacji opacity.
Production `useSceneResource` obserwuje rewizję 4 i zero transportów już
podczas held GET listy. Rewizja 5 z odtworzonym rekordem przywraca dostęp
bez remount i zachowuje `2.7e-1`. Late ACK zachowuje `2.8e-1` po reselect,
nie przyznaje tej generacji sukcesu i nie zatruwa późniejszego New.
Obejrzano końcowe screenshoty 24/26/31 i 29; potwierdzają zachowany układ
oraz tekst i odrębny stan obserwowanej sceny.

Receipt browser względem
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:
`windows-control-room-browser-fixture/antenna-transport-drafts-browser/af7baf0e070f4fea91003fcf58ae1873/receipt.json`.
HEAD z zależnym WIP: `d475e7f4779677339f1206d18baf7106afa00766`;
digest przed/po
`852bfd02d236f307214d0666b45240f5bca3a29bf05acf4753024369c8280868`,
exit 0, `owned_server_terminal=true`, `source_changed_during_run=false`.

**Pozostałe końcowe bramki tego samego digestu:**

- Produkcyjny TypeScript noEmit: `windows-control-room-source-check/production-source/d0c22e22e4fc4105ac19b80285f9483b/receipt.json`, PASS, exit 0, pusty log; test files wyłączone z kompilacji.
- ESLint: `windows-control-room-source-check/lint/1b44b0b4f2b44b81a0d76f4eff3fa134/receipt.json`, PASS, exit 0, pusty log.
- React Doctor offline: `windows-control-room-source-check/react-doctor/4969988694734e20a82bd62ed37bda54/receipt.json`, exit 0, 45 przeskanowanych plików, 6 wcześniejszych ostrzeżeń; brak nowej grupy diagnostycznej.

Każdy receipt ma przed/po ten sam digest co GREEN browser i
`source_changed_during_run=false`. Sześć uwag zachowuje poprzednią,
zweryfikowaną klasyfikację: `window` jako pole typu i guardowana arytmetyka
DOS to false positive (wysoka pewność); non-null mesh ACK needs-review
kontraktu invalidations (średnia pewność); dirty-key lookup, filter/map
stacji i index-key read-only preview to true positive struktury (wysoka
pewność), bez dowodu mierzalnej degradacji. Reguł nie wyciszano.
Higiena API/architektury, parser mapy naukowej i `git diff --check`: exit 0.
Stan całego checkoutu: 139 zmienionych tracked i 48 untracked liczone
z `--untracked-files=all`, brak konfliktów, pusty index. Nie jest to liczba
plików tej poprawki. Nie awansuje żadnej bramki naukowej ani backendowej.

Fixture używa produkcyjnego panelu, typed API, resource hooks, sceny,
historii i edit-session store, ale kontroluje odpowiedzi HTTP. Nie
wykonuje backendu, mesh/current solve ani dowodu naukowego. Airbox nie
jest właścicielem transportu; nie zmieniono jego Inspectora/viewportu.
Deklarację unit testu oczekującą starego fallbacku rewizji skorygowano;
testów jednostkowych nie kompilowano ani nie uruchamiano. Nadal otwarte:
spin browser, inkarnacja session/client, zależności uniemożliwiające
Delete w prawdziwym backendzie, Undo/Redo end-to-end, natywne HTTP
create→solve→inspect, quantity/projekcja/baza, Relax/LLG/FFT i T18.
Wspólny BuildRunner pozostaje bez deploy/restartu i czeka na odrębną
decyzję operatora. Zależny WIP pozostaje razem; brak nowego commita/PR.

### Checkpoint 2026-10-05 — Create ACK, zmiana celu i generacja formularza

Kontynuacja poprzedniego checkpointu dotyczy `TransportAuthoringInspector`.
Naprawiono przeniesienie lokalnego draftu po Create do dokładnej tożsamości
zatwierdzonej przez serwer. Jest to authoring UI, **nie solve, odbiór T15/T18
ani kwalifikacja żadnej z czterech realizacji backendowych**. Nie zmieniono
Python DSL, `ProblemIR`, OpenAPI, fizycznych parametrów, równań ani SI.

Rzeczywista regresja RED `b3ee5fa2998e42e0823191db80518479` wykonała POST
Create przy `base_revision=1`, zachowała nowszą edycję podczas oczekiwania,
otrzymała ACK rewizji 2 i opóźniła GET listy. Panel wrócił do defaultowego
transportu `current`/`prescribed_density`, usuwając edytowany drugi cut;
locator nie mógł go już znaleźć. Dziewięć wcześniejszych grup przeszło,
bez błędów strony/konsoli. Guard fixture odnotował późniejszą próbę walidacji
nowego transportu; nie jest to osobny błąd solvera. Receipt potwierdza
niezmienne źródła i zamknięcie własnego serwera.

Przyczyna: po ACK draft pozostawał pod kluczem „new”, natomiast wybór
utworzonego transportu zmieniał klucz dwukrotnie: przed nadejściem listy
na `id:...`, a po jej odświeżeniu na rozpoznane ID. Adres jest teraz
rozstrzygany z jawnego ID lub lokalnego wyboru niezależnie od chwilowej
obecności rekordu w liście. W ACK draft, baseline, rewizja i feedback
przechodzą razem na konkretny klucz utworzonego transportu. To nie jest
globalny alias draftów nowych obiektów. Przejściowa opcja wyboru pokazuje
zaakceptowane ID z oznaczeniem `refreshing`; akcja oznacza Replace, nie
ponowny Create. Zapis jest zablokowany, dopóki lista nie dogoni rewizji ACK.

Name/Id jest read-only podczas zapisu i po przyjęciu ID, także przed GET.
Pozostałe edytowane parametry pozostają dostępne i mogą mieć nowszy draft;
nie wprowadzono target-wide blokady inputów. `resetDraft` zachowuje rewizję
ACK przy tym samym celu, więc Discard przed końcem odświeżania listy przyjmuje
zatwierdzoną bazę, nie stare/defaultowe dane.

Lokalny wybór transportu jest przypięty do session scope, rodziny,
object/region i zewnętrznego adresu. Przejście zakresu A→B→A resetuje ten
wybór, draft i konflikt przed renderem nowego celu; panel nie polega na
remount. Jawne `resourceId` ma pierwszeństwo przed zmiennym indeksem listy.
Zmiana indeksu przy tym samym ID nie jest zmianą ownera i nie resetuje edycji.
Pending ma dodatkowo generację formularza. Spóźniony ACK po A→new→A nadal
publikuje poprawną kanoniczną zmianę w cache właściwej sesji, ale nie
promuje lokalnej bazy ani feedbacku innej generacji. Nowszy draft otrzymuje
zwykły konflikt nakładających się zmian, zamiast niejawnego rebase.

Pierwsza próba poprawki ujawniła pozostałą etykietę Create zależną od obecności
rekordu, mimo już zaakceptowanego ID (`28187ce72a674df8ac39e2554b7f4854`);
poprawiono rzeczywistą etykietę, nie asercję. Następny browser
`5f7409fca04f4a3bb85f67209e3bcfc6` zaliczył **13 grup**, 23 screenshoty,
37 żądań/135 renderów existing flow oraz 18 żądań/85 renderów create/scope.
Create→ACK zachował root, row i input DOM, fokus, selection `[1,3]`,
scroll delta 0 i zero animacji opacity. Lokalny tekst `4.6e-1` pozostał
po ACK zatwierdzającym `0.45`; dopiero jawny Replace rewizji 2 wysłał `0.46`.
Spóźniony ACK zatwierdzający `0.47` po reselect nie zastąpił `4.8e-1`
ani nie usunął wymogu rebase. Obejrzano screenshoty 17/18 i 22, potwierdzając
stabilny układ inputów oraz jawny konflikt. Porównanie zagnieżdżonego closure
pozostaje atomowe i tekstowe, nie nowym szczegółowym edytorem różnic.

TypeScript wykrył w fixture odczyt `path_id` przed zawężeniem discriminatora
`candidate.kind`; dodano rzeczywisty guard, bez type assertion. Review
źródeł znalazł także Discard/held GET i redundantny indeks ownera; obie
poprawki mają dodatkowe scenariusze w zarządzanej regresji. Wyniki końcowego
przebiegu należy czytać wraz z receipts opisanymi poniżej, nie traktować
wcześniejszego GREEN jako dowodu niezmienionych później źródeł.

**Browser PASS przed korektą lint:** 15 grup, 23 screenshoty, 38 żądań/141 renderów
existing flow i 18 żądań/89 renderów create/scope. Obejmuje również
niezmienne ID przy zmienionym indeksie adresu oraz produkcyjny reset
wywołany przez `InspectorEditSessionProvider`/edit-session store podczas
held GET. Fixture Discard jest kontrolką harnessu wywołującą produkcyjny
callback reset; nie dowodzi całego nadrzędnego menu/navigation guard.
Nie ma błędów strony/konsoli ani nieoczekiwanych żądań.

Receipt browser, względem
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:
`windows-control-room-browser-fixture/antenna-transport-drafts-browser/b714d52f5ed148abbbe6a1ff0fbf55de/receipt.json`.
Digest przed/po:
`db9d4ae9eba582f2c1bdca74e2f30ea55f9ea40f96889adead48f23f80856f09`;
exit 0 i `owned_server_terminal=true`. Produkcyjny TypeScript noEmit
z wyłączeniem unit tests: PASS,
`windows-control-room-source-check/production-source/52bb67eb769f45c4acd01a13ffe96875/receipt.json`,
ten sam niezmieniony digest. Mapę planu zweryfikowano parserem kontraktu
naukowego; sama mapa nadal ma `source_only`, nie status walidacji fizyki.

ESLint tego snapshotu (`c4018db659d442c2935bedf0691b9944`) wykrył odczyt
`activeDraftGeneration.current` podczas renderowania pending. To rzeczywisty
błąd ownership/render, nie powód do suppression. Generacja jest teraz
częścią draft state React i służy do wyprowadzenia widocznego pending;
ref jest aktualizowany wyłącznie po commit w layout effect i odczytywany
przez asynchroniczne guardy. Kolejne kontrole dotyczą tego poprawionego
snapshotu; powyższy browser pozostaje dowodem historycznym, nie końcowym.

**Końcowy snapshot po korekcie lint:** HEAD
`d475e7f4779677339f1206d18baf7106afa00766` z zależnym WIP;
digest frontendu przed i po każdej z czterech bramek:
`620d5c3d930dd2eed1f1c1aa826c9239a23acb9b9e6ec08b046b8c7b61881b13`.
Wszystkie mają exit 0 i `source_changed_during_run=false`.
Receipts względem podanego wyżej rootu storage:

- TypeScript produkcyjny noEmit: `windows-control-room-source-check/production-source/92c4177a580d40e4a68cc9703ba7ae97/receipt.json`, PASS.
- ESLint: `windows-control-room-source-check/lint/07782eb4278b4324aac0c1a414933368/receipt.json`, PASS; pusty log.
- Browser: `windows-control-room-browser-fixture/antenna-transport-drafts-browser/65469cc054234bae95dc9549bd76c8b8/receipt.json`, PASS; `owned_server_terminal=true`.
- React Doctor offline: `windows-control-room-source-check/react-doctor/d4cca373714e49bb8173729a678784d7/receipt.json`, exit 0; 44 pliki, 6 ostrzeżeń, bez nowej grupy diagnostycznej.

Końcowy browser zaliczył **15 grup**, bez niezaliczonych asercji;
zapisał 23 screenshoty. Existing flow: 38 żądań i 141 renderów;
create/scope: 19 żądań i 91 renderów. Są to osobne strony/scenariusze,
nie koszt pojedynczego zapisu. Brak nieoczekiwanych żądań, błędów strony
i błędów konsoli. Kontrole DOM nadal potwierdzają zachowany root,
row/input, fokus, selection `[1,3]`, scroll delta 0 i brak animacji
opacity w opisanych przejściach. Obejrzano końcowe screenshoty 17/18:
ten sam tekst `4.6e-1`, fokus i układ przed/po Create ACK z held GET.
Screenshot 22 pokazuje jawny konflikt `0.47` kontra `4.8e-1`, Rebase
Draft i zablokowany Replace; nie jest dowodem poprawności solve.

Sześć ostrzeżeń Doctor zweryfikowano w źródłach: pole interfejsu
`window` oraz chroniona guardami arytmetyka DOS to false positive
(wysoka pewność). Non-null mesh ACK pozostaje needs-review kontraktu
invalidations (średnia pewność), poza zakresem tej poprawki.
Dirty-key lookup, filter/map stacji i index-key read-only preview są
true positive struktury (wysoka pewność), bez zmierzonego kosztu ani
dowodu utraty szkicu w tych miejscach. Nie wyciszono reguł i nie wykonano
niezwiązanego refaktoru. Higiena API/architektury, parser mapy kontraktu
naukowego i `git diff --check`: exit 0.

Stan integracji: 138 zmienionych plików tracked, 48 untracked liczonych
z `--untracked-files=all`, brak konfliktów i pusty index. To stan całego
zależnego worktree, nie liczba plików tej poprawki. Nie wykonano nowego
commita, push ani PR; wycięcie samego panelu/fixture nie kwalifikuje
zależnych zmian API, callerów i runtime. Następny krok natywny wymaga
odrębnej zgody na aktualizację wspólnego koordynatora, a następnie
zarządzanego buildu i rzeczywistego HTTP create→solve→inspect.

Nadal otwarte: transport delete, spin UI, zmiana inkarnacji sesji/klienta,
wiele jednoczesnych mutacji różnych celów, rewizja zmieniająca się podczas
przygotowania historii, natywne HTTP/create→solve→inspect, quantity i
kwalifikowana baza/projekcja, Relax/LLG/FFT oraz odbiór T18. Ten browser
korzysta z produkcyjnych paneli, typed API, resource hooks i edit-session
store, lecz kontroluje odpowiedzi HTTP; nie wykonuje backendu ani fizyki.
Unit tests nie były kompilowane ani uruchamiane. Wspólny BuildRunner nie
był wdrażany/restartowany; oczekiwana osobna decyzja operatora pozostaje
niezależna od zaliczonych kontroli frontendu. Zależny WIP zachowano razem.

### Checkpoint 2026-10-05 — draft transportu, source cuts i jawny rebase

Naprawiono `TransportAuthoringInspector` i jego model draftu. Jest to
przyrost authoringu transportu anteny, **nie odbiór T15/T18 ani solvera**.
Dowody dotyczą HEAD `d475e7f4779677339f1206d18baf7106afa00766` wraz
z zależnym WIP. Nie zmieniono równań, jednostek SI, Python DSL,
`ProblemIR`, wire schema ani realizacji FDM CPU/GPU i FEM CPU/GPU.

Źródłowa przyczyna utraty edycji: klucz formularza zawierał serializowany
zasób serwera, a klucz wiersza source cut zależał od edytowanego ID
i indeksu. Tożsamość formularza jest teraz przypięta do potwierdzonego
session scope, rodziny transportu i wybranego celu, nie do rewizji jego
parametrów. Każdy source cut ma lokalny `rowId`; zmiana fizycznego ID
lub usunięcie wcześniejszego wiersza nie wymienia jego DOM. Dodawanie
generuje unikalne source-cut/circuit/drive ID po usunięciu lub rename.
`rowId` nie trafia do payloadu ani fizyki. Nie wykonano osobnego browser
RED na wersji sprzed poprawki; diagnoza jest źródłowa, GREEN wykonany.

Model `reconcileTransportDraft` porównuje trzy wersje: bazę, aktualny
zasób serwera i lokalny draft. Niezmienione lokalnie pola przyjmują
nową wartość serwera, zmienione zachowują tekst użytkownika. Jednoczesna
różna zmiana tego samego pola jest konfliktem blokującym zapis. Porównanie
pomija wyłącznie lokalne `rowId`; nie zaokrągla wartości fizycznych.
Structured closure oraz pola JSON są jednostkami atomowymi, nie
implementacją automatycznego merge wewnątrz zagnieżdżonego obwodu.

Zapis używa dokładnej rewizji, dla której zbudowano i zwalidowano
payload. Jeśli przygotowanie historii stwierdzi inną rewizję, stary
payload nie jest wysyłany pod nową bazą. Pełny scoped ACK publikuje
kanoniczną scenę i unieważnia właściwe zasoby. Zmiany wykonane podczas
pending pozostają niezapisanym draftem po ACK; zatwierdzona wersja staje
się jego bazą także przed odświeżeniem listy. Kolejny zapis jest jawny.
Pending nie wyłącza inputów, dodawania ani niezależnych kontrolek.
Feedback i obsługa lokalnego ACK mają guard celu, ownera i generacji.

HTTP 409 zachowuje draft i odświeża zasób bez automatycznego retry.
Panel pokazuje konflikt, a przy nakładającej się zmianie również wartości
Server/Draft. `Rebase Draft` przyjmuje aktualną bazę, zachowując lokalne
edycje, ale **nie wykonuje zapisu**. Dopiero następne jawne Replace
wysyła payload z aktualną rewizją. Obejrzano screenshoty porównania
i odrzuconego zapisu: baner, blokada Replace i przycisk rebase są widoczne,
a lokalna tolerancja nie jest zastępowana wartością serwera.

`just verify-antenna-transport-drafts-browser` uruchamia produkcyjny
Inspector, typowany klient i resource hooks w zarządzanej fixture na
porcie 3254; kontrolowane są odpowiedzi GET, walidacji POST oraz PATCH.
Fixture rozpoznaje prawidłowy kontrakt Ohmic/CG i oznacza walidację
`semantic_only`. Nie uruchamia backendu, siatki, prądu ani pola.
Trasa jest dokładnie whitelisted; źródła, cache i dowody są pod storage,
a wrapper zamknął wyłącznie własny serwer (`owned_server_terminal=true`).

**Browser PASS:** 9 grup, 37 żądań, 135 commitów Profilera,
15 screenshotów i zero błędów strony/konsoli lub obcych żądań.
Sześć jawnych prób PATCH obejmuje jeden odrzucony zapis 409; ich
`base_revision` wynosi kolejno 1, 2, 4, 6, 7, 8. Nie ma implicit retry.
Mierzony pending/ACK: `rootChanged=0`, `controlIdentityChanges=0`,
`disabledChanges=0`, `opacityChanges=0`, `activeOpacityAnimations=0`,
`maxScrollDelta=0`; fokus i selection range pozostają zachowane.
Ta transakcja zajęła 4 żądania i 14 renderów. Niezależne odświeżenie
zachowuje lokalną edycję i przyjmuje nieedytowane pole serwera; konflikt
tego samego pola oraz faktyczny 409 wymagają jawnego rebase. Uspokojony
panel nie wykonuje nowych żądań ani renderów.

Receipt browser, względem
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:
`windows-control-room-browser-fixture/antenna-transport-drafts-browser/6b1e7cfdc6794a72bc37c5a4372fed39/receipt.json`.
Digest przed/po identyczny:
`b68445de4cf7b97cda4313151e3730f4935b2b56afc0aa8051b5ee782767a990`;
exit 0. Produkcyjny TypeScript noEmit: PASS,
`windows-control-room-source-check/production-source/58236a0c62af402287725227b03beb37/receipt.json`,
ten sam digest. Początkowy typecheck fixture wykrył dostęp do solvera
opaque transportu; naprawiono go rzeczywistym guardem
`isKnownCurrentTransport`, bez wymuszania typu.

Interpretowane wykonanie produkcyjnego modelu przez Node type erasure
zaliczyło 9 grup: niezależne zmiany, overlap, nowsze edycje po ACK
i rebase osobno dla current/spin oraz tożsamość wierszy bez wpływu na
payload. Deklaracje regresji modelu rozszerzono, ale **unit tests nie
były kompilowane ani uruchamiane**. Browser dotyczy existing current
transport; create/delete, spin UI, owner/target ABA oraz zmiana rewizji
podczas przygotowania historii wymagają osobnych browser scenariuszy.
W szczególności pojedynczy miernik pending nie dowodzi wszystkich
przeplotów transakcji wielu celów.

Końcowy ESLint: PASS, exit 0 i pusty log,
`windows-control-room-source-check/lint/c5fc7230ed2d452d88d91e6a6a3f7e7e/receipt.json`.
React Doctor offline: exit 0, **44 pliki i 6 ostrzeżeń**,
`windows-control-room-source-check/react-doctor/730460ce2ef7456f8eb40c122c9454f8/receipt.json`.
Oba mają ten sam niezmieniony digest co browser i produkcyjny TS.
Usunięto index-key edytora source cuts; nie wyciszono pozostałych uwag.
Odczyt źródeł potwierdza: `window` jest polem interfejsu, nie dostępem
do browser global (false positive, wysoka pewność); mnożenie DOS odbywa
się po guardzie liczby skończonej dodatniej, nie na optional-chain
(false positive, wysoka pewność). Non-null mesh ACK wymaga osobnego
review kontraktu invalidations (needs review, średnia pewność).
Dirty-key lookup i filter/map stacji występują rzeczywiście, lecz
ostrzeżenia nie mierzą ich kosztu (true positive struktury, wysoka
pewność; brak dowodu problemu wydajności). Index-key stateless preview
występuje rzeczywiście, ale nie dowodzi utraty edycji w tym read-only
widoku (true positive struktury, wysoka pewność). Nie wykonano
niezwiązanego refaktoru. Higiena API/architektury, parser mapy naukowej
i `git diff --check` zakończyły się exit 0; to kontrole kontraktów
i źródeł, nie kwalifikacja backendu.

Pozostają otwarte rzeczywisty native HTTP create→solve→inspect,
field-map/quantity, qualified projection i baza na amper, Relax/LLG/FFT,
pozostałe inspectory oraz odbiór T18. Wspólny koordynator BuildRunnera
nie był wdrażany ani restartowany; decyzja operatora pozostaje odrębna.
Zależny WIP panelu, callerów, stylów i zarządzanych recept pozostaje razem;
ten checkpoint nie jest dowodem kwalifikacji całego WIP.

### Checkpoint 2026-10-04 — stabilna tożsamość stacji microstrip i ACK draftu

Naprawiono lokalny edytor stacji geometrii `MicrostripAntennaLayout`:
`MicrostripGeometryEditor` i `MicrostripGeometryEditorModel`. Jest to
**przyrost authoringu UI**, nie zamknięcie T15/T18 ani kwalifikacja
siatki, prądu lub pola. Kontrole dotyczą HEAD
`d475e7f4779677339f1206d18baf7106afa00766` i zależnego WIP. Nie zmieniono
równań, SI, Python DSL, `ProblemIR`, wire schema ani backendów.

Regresja RED rzeczywistego panelu (`8ecc1001218e4ff7a107aaa285acf912`)
potwierdziła, że `key={index}` po usunięciu wcześniejszej stacji wymieniał
DOM późniejszego wiersza mimo poprawnych wartości. Każdy draft ma teraz
lokalny `rowId`; nowe ID powstaje w zdarzeniu dodawania, a nie podczas
renderowania. Edycja i usuwanie wskazują ID, nie indeks listy. ID nie jest
polem geometrii, Python ani IR: `buildMicrostripGeometry` serializuje
wyłącznie `s` i `signal_width_m`. `widthStationsEqual` porównuje skończone
wartości liczbowe, bez ID i różnic zapisu typu `17e-9`/`1.7e-8`; nie
wprowadza tolerancji numerycznej ani zaokrąglania fizycznych parametrów.

ACK pełnej `committed_scene` trafia do obserwowanego cache konkretnego
klienta i session scope. Wiersze i tekst draftu pozostają w tym samym
panelu; aktualizowana jest baza porównania (`sourceGeometry` i
`baselineStations`), nie usuwany cały lokalny formularz. Nowsza edycja
wykonana podczas pending pozostaje niezapisana po ACK i nie jest
fałszywym konfliktem własnej transakcji. Kolejny zapis jest jawny i używa
zatwierdzonej rewizji. Pending dotyczy przycisku Save tej transakcji,
nie innych kontrolek. Draft/feedback/pending są przypięte do object ID
i session scope; pełny browser scenariusz zmiany ownera pozostaje osobną
bramką, nie został dowiedziony tym harnessiem.

Review i interpretowane wykonanie produkcyjnego modelu wykryły dodatkową
kolizję: przesunięta stacja zachowywała ID dawnego położenia, które nowa
stacja z serwera mogła dostać ponownie. `widthStationDraft` uzgadnia
istniejące wiersze według położenia i rezerwuje wszystkie poprzednie ID
przed nadaniem nowych; przypisane ID są unikalne także dla niepoprawnego
duplikatu pozycji. Nowy browser scenariusz przesuwa stację, zatwierdza ją,
następnie dodaje serwerową stację na dawnej pozycji. Zachowano DOM, fokus
i zaznaczenie przesuniętej stacji; nowy wiersz ma oddzielną tożsamość.
Nie nadano w ten sposób stacjom nowej semantyki fizycznej.

Zarządzana recepta `just verify-antenna-microstrip-stations-browser`
używa stałej dopuszczonej trasy na porcie 3253. Snapshot źródeł, cache,
logi i obrazy są pod resolverowym storage; wrapper nie nadpisuje
produkcyjnej strony, nie instaluje zależności i zamyka tylko własny
serwer. Pierwsza próba została odrzucona przez guard przed uruchomieniem;
dodano dokładną whitelisted receptę, nie ogólną możliwość wykonania tekstu.
Fixture używa produkcyjnego edytora, `ControlRoomApi`, `useSceneResource`
i cache; tylko odpowiedzi GET/POST są kontrolowane. Nie uruchamia backendu.

**Browser PASS:** 9 grup, 8 żądań (w tym 3 jawne zapisy), 28 commitów
Profilera, 13 screenshotów, zero błędów strony/konsoli i obcych żądań.
Usunięcie/dodanie zachowuje DOM wierszy, inputów, fokus i selection range.
Pending/ACK: `rootChanged=0`, `controlIdentityChanges=0`,
`disabledChanges=0`, `opacityChanges=0`, `activeOpacityAnimations=0`,
`maxScrollDelta=0`; 1 żądanie i 3 rendery w mierzonej transakcji. Jawne
odświeżenie innej rewizji zachowuje dirty draft bez fałszywego konfliktu;
idle nie pobiera danych ani nie renderuje. Obejrzano obrazy przed i po ACK:
układ i aktywny input pozostają, nowsza szerokość `17e-9` nie jest zastąpiona
zatwierdzonym wcześniej `18e-9`; pojawia się tylko komunikat wyniku.

W harnessie skorygowano dwa błędne oczekiwania: interpolowana szerokość
jest referencją obliczoną w double, nie ręcznie zaokrągloną stałą; pełny
ACK do właściwego cache nie wymaga redundantnego GET tej samej rewizji.
Test nadal sprawdza dokładny payload, canonical dependent invalidations
oraz osobne rzeczywiste odświeżenie zasobu. Typecheck wykrył także zbyt
wąski typ tablicy literalnych ścieżek w fixture; zastąpiono go jawnym
porównaniem dwóch ścieżek, bez type assertion i bez zmiany kontraktu.
Rozszerzone deklaracje testów modelu **nie były kompilowane ani uruchamiane**;
wykonany browser i natywne type erasure modelu nie są buildem unit tests.

Końcowy browser receipt, pod
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/`:
`windows-control-room-browser-fixture/antenna-microstrip-stations-browser/2aaaf920ec0c4c45b854ef25bede00e2/receipt.json`.
Źródła przed/po są identyczne:
`4cc00fef44419fcfa80869ee821a1e821c6e65ee298ce9b55498178f18688cf3`;
exit 0, `owned_server_terminal=true`. Produkcyjny TS noEmit:
`windows-control-room-source-check/production-source/94a8992da45c45a596b8340ce602dbe5/receipt.json`, PASS.

Końcowy ESLint: `windows-control-room-source-check/lint/bbf5487db06c46399d0123dc1fb3996b/receipt.json`,
PASS, pusty log, exit 0. React Doctor 0.9.12 offline:
`windows-control-room-source-check/react-doctor/bdf78ed6837849129de28c6fdab39aac/receipt.json`,
exit 0, **42 pliki i 7 ostrzeżeń**. Oba receipts potwierdzają ten sam
niezmieniony digest źródeł co browser i produkcyjny TS. Doctor nie zgłasza
już index-key w edytorze stacji; liczba ostrzeżeń nie spadła, ponieważ
doszło `js-combine-iterations` w `widthStationDraft`: istnieją `filter`
i `map` tworzące małą pomocniczą tablicę. Jest to trafna obserwacja
struktury (wysoka pewność), ale bez pomiaru nie jest dowodem istotnego
problemu wydajności; pozostawiono ją bez wyciszenia i bez refaktoru
niemającego wpływu na zweryfikowany błąd tożsamości. Pozostałe sześć
findingów z wcześniejszego review nadal jest jawne: pole typu `window`,
non-null assertion mesh ACK, dirty-key lookup, dwa index-key w edytorze
cut i stateless preview oraz optional arithmetic w modelu transportu.
Nie przedstawia się exit 0 jako braku problemów ani odbioru całego T15.
Końcowe `check-architecture-hygiene.mjs` i `check-api-hygiene.mjs`
zakończyły się exit 0. Obejrzano także końcowe obrazy 12/13: dodanie
wiersza na dawnej pozycji nie przenosi fokusu ani zaznaczenia z edytowanej
stacji; jej etykieta zmienia numer zgodnie z kolejnością geometrii.

Nie promuje to żadnej antenowej realizacji FDM CPU/GPU ani FEM CPU/GPU.
Nadal otwarte: rzeczywisty native HTTP i create→solve→inspect,
field-map/quantity, qualified projection/baza na amper, Relax/LLG/FFT,
pozostałe inspectory/konflikty i T18. Wspólny koordynator BuildRunnera
nie był wdrażany/restartowany; oczekiwana zgoda pozostaje odrębna.
WIP panelu, jego callerów, stylów i zarządzanych recept pozostaje razem;
nie wydzielono commita pozostawiającego niespójne podłączenie UI.

Uzupełnienie 2026-10-02 (niezależna rewizja sceny): Inspector składa widoczny
draft z aktualnego zasobu sceny i tylko lokalnie zmienionych pól. Dzięki temu
niezapisana amplituda pozostaje w edycji, ale późniejsza zmiana fazy lub
offsetu na serwerze nie zostaje przy zapisie przywrócona ze starej migawki.
Rozszerzono regresję DOM o wartości formularza i payload transakcji po
rewizji sceny. Typecheck przeszedł; uruchamianie unit testów nadal jest
zabronione przez `AGENTS.md`. Dodano także porównanie edytowanych pól z ich
migawką bazową: przy nowszej, odmiennej wartości serwera Save jest blokowany,
Inspector pokazuje obie wartości, a użytkownik musi jawnie wykonać
`Rebase Draft`. Regresja DOM obejmuje tę ścieżkę; nie została uruchomiona z
powodu zakazu testów jednostkowych. Pełny browser smoke i kwalifikacja runtime
pozostają otwarte.
Po ACK, gdy zasób serwera osiągnie wartość lokalnego draftu, następna edycja
tego pola przyjmuje nową wartość jako bazę konfliktu; dodano regresję DOM dla
sekwencji zapis → ACK → ponowna edycja. Typecheck, lint zmienionych plików i
`check:architecture-hygiene` przeszły, lecz regresja nie została wykonana.

Uzupełnienie 2026-10-02 (puste parametry przebiegu): `parseFinite` w modelu
regionalnego edytora anteny odrzuca teraz pusty/blank draft zamiast
konwertować `Number("")` na zero. Dotyczy to m.in. fazy i offsetu sinusoidy,
amplitudy oraz `t0` sinc; nieedytowane wartości nadal pochodzą z istniejącego
drive. Dodano regresje źródłowe dla fazy, offsetu i amplitudy sinc.
Zarządzony przez resolver frontendowy `pnpm --dir apps/control-room typecheck`
zakończył się kodem 0. Unit testów nie uruchomiono zgodnie z zakazem w
`AGENTS.md`; pełny browser smoke T15 pozostaje otwarty.

Uzupełnienie implementacyjne 2026-09-21: dedykowany Inspector `drive` pokazuje
teraz deklarowane `bandwidth_declaration.f_max_hz` jako osobny wiersz. Brak
deklaracji pozostaje jawnie `not declared`, a wartość niefinitywna jest
oznaczana jako `invalid declaration`; UI nie wyprowadza pasma z czasu impulsu
ani z próbkowania. Formatter ma test Vitest 5/5, a ESLint zmienionych plików
przechodzi. Formalny typ OpenAPI jest już wygenerowany; edycja deklaracji,
walidacja konfliktu i pełny browser smoke nadal należą do T14/T15.

**Stan 2026-09-11:** dedykowane węzły Explorer i routing Inspectora są już podłączone, a `AntennaCompositionPanel` rozwiązuje authored stage/request do właściwych `output_id` i korzysta z typowanych hooków wyników anteny. Węzły `solution` i `spectrum` pokazują stan zasobu (`loading/ready/stale/error/missing`) oraz metadane manifestu; `projection` i `drive` pokazują dostępność opublikowanej bazy pola. Dodano test resolvera identyfikatorów oraz DOM regresję gotowego wyniku. Commit `d48f32cd9` dodaje dekodowanie czterech payloadów `float64_le`, bounded heatmapę `|H(k_u,k_v)|²` z peak/k-grid oraz testy gotowego i błędnego transportu; `cae985d3b` zachowuje kody `missing_payload`/`unsupported_topology` jako jawny błąd Inspectora zamiast maskowania ich jako brak zasobu. Nadal brakuje pełnego browser smoke `create → solve → inspect → stale` i diagnostyki React dla całego workflow.

**Uzupełnienie implementacyjne 2026-09-21:** `AntennaCompositionPanel` korzysta
z typowanego `useAntennaStageOutputCatalogResource`. Resolver przekazuje teraz
`stageId` dla węzłów `solution`, `projection`, `drive` i `spectrum`, a Inspector
pokazuje osobno stan katalogu (`ready/loading/stale/error/missing`), status i
rewizję stage, opublikowane output IDs, quantities, digest oraz diagnostykę.
Pozostaje to cienkimi metadanymi control plane; payloady pola i FFT nie są
ładowane przez ten panel. Dodano regresję modelu i DOM dla gotowego katalogu.
Pełny browser smoke, diagnostyka React oraz kwalifikacja runtime nadal pozostają
otwarte.

W tej samej iteracji helpery runtime i formatter pasma zostały wydzielone z
pliku komponentu do modułów modelu. React Doctor nie zgłasza już ostrzeżeń
`only-export-components` dla tego obszaru.

**Uzupełnienie implementacyjne 2026-09-21 (draft i rewizja):**
`AntennaObjectPanel` odrzuca zapis, gdy zasób sceny nie jest `ready` albo nie
udostępnia bezpiecznej rewizji całkowitej. Canonical `replaceFieldDrive` oraz
legacy `merge_patch` migracji przekazują jawne `base_revision`; pełna tablica
nie może już nadpisać nowszej sceny bez konfliktu. Test DOM 5/5 sprawdza
canonical zapis, zachowanie `phase/offset` podczas edycji amplitudy, migrację
legacy, zachowanie niezapisanego draftu przy niezależnej rewizji sceny oraz
aktywny fokus i niezależne kontrolki w stanie pending. Dodany workflow 409
`Refetch Scene → Rebase Draft → Retry Save` pokazuje porównanie server/draft,
zachowuje lokalny draft do jawnego rebase i ponawia zapis z nową rewizją.
Łącznie testy modelu/DOM przechodzą 11/11; nie zamyka to pozostałego T15.

Komenda `Add Microstrip Antenna` również pobiera rewizję z tego samego
`SceneResource` odpowiedzi `scene()` i przekazuje ją w `merge_patch`. Brak
rewizji kończy się jawnie `failed`, a równoległe komendy podlegają serwerowemu
409 zamiast bezwarunkowego nadpisania. Test authoringu 42/42 obejmuje oba
przypadki.

**Uzupełnienie implementacyjne 2026-09-21 (kontrakt portu v2 w presecie):**
Test authoringu ujawnił, że `Add Microstrip Antenna` nadal wysyłał legacy
`terminal_selector_ref` bez discriminatora, mimo że kanoniczny
`AntennaPortModeIR` wymaga `schema_version="antenna_port_mode.v2"` i jawnych
par `inlet_terminal_ref/outlet_terminal_ref`. Preset został zaktualizowany:
current transport ma cztery rozłączne elektrody (`signal_in/out` oraz
`return_in/out`) i jawnie izolowane `x_min/x_max`, a port ma dwie gałęzie o
wagach `+1/-1`. Test `geometryLifecycleCommandContributions.test.ts` przechodzi
42/42 i sprawdza także brak legacy pola. Jest to naprawa serializacji i
authoringu; nie zamyka T02/T05/T06 ani nie stanowi dowodu zbieżności solve,
bilansu terminali lub kwalifikacji 3D FEM.

W tym samym kroku poprawiono dedykowany conductor Inspector: obiekty sceny
emitują `geometry.geometry_kind`, więc panel używa tego pola (z zachowaniem
fallbacku dla starszego `geometry.kind`). Testy modelu/DOM kompozycji przechodzą
7/7; zmiana dotyczy prezentacji authoringu i nie podnosi statusu gotowości
solverów.

Explorer waliduje teraz także strukturalną gotowość portu: schema v2, minimum
dwie gałęzie, unikalne pary terminali, niezerowe skończone wagi, suma dodatnia
równa `1` i suma wszystkich wag równa `0`. Niepoprawny port otrzymuje
`warning` oraz badge `invalid`, a poprawny port `ready`; test Explorera obejmuje
oba przypadki. Dedykowany port Inspector pokazuje tę samą walidację w wierszu
`Validation`, a reguły są współdzielone przez Explorer i Inspector w
`apps/control-room/src/modules/antenna/antennaPortValidation.ts`. Jest to
diagnostyka authoringu, nie wynik runtime solve.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja stage solution):**
dedykowany Inspector stage `solution` nie pokazuje już ogólnego
`configured · result pending`, gdy jego referencje są niekompletne. Przed
publikacją pola sprawdza obecność `current_transport_id`, każdego
`port_mode_id`, zgodność źródła/transportu portu oraz wymagane wyjście
`H_ant_basis`. Konkretne braki trafiają do wiersza `Validation`, a badge ma
stan `invalid · result pending`; poprawny, ale jeszcze niewykonany stage
pozostaje `configured · result pending`. Test DOM tego panelu przechodzi 4/4,
ESLint i React Doctor pozostają zielone. To nadal wyłącznie kontrakt i
diagnostyka metadanych UI — nie kwalifikacja solve, Relax/LLG ani GPU.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja projection):**
Inspector `projection` sprawdza teraz referencję do stage i outputu oraz
wymaga, aby wskazany output publikował `H_ant_basis`. Dla targetów typu
`object` i `region` sprawdzana jest również obecność obiektu, a dostępny
region jest rozpoznawany po `region_id` lub kanonicznej nazwie. Braki są
pokazywane w wierszu `Validation`, a badge przyjmuje stan
`invalid · result pending`; global target nie wymaga listy obiektów. Testy
modelu i DOM kompozycji przechodzą 10/10. To walidacja referencji authoringu,
nie dowód projekcji numerycznej ani kwalifikacja runtime.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja solved drive):**
Inspector `drive` sprawdza teraz `port_mode_id`, `projection_ref` oraz każdy
stage wskazany przez `activation.kind=stage_ids`. Gdy projekcja istnieje,
przenosi także jej błędy referencji do diagnostyki drive. Wiersz `Validation`
i badge `invalid · result pending` odróżniają brak konfiguracji od samego
oczekiwania na wynik; nie zmieniono oceny waveformu, amplitudy ani czasu.
Łączne testy modelu/DOM kompozycji przechodzą 11/11 (DOM 6/6), ESLint i
React Doctor pozostają zielone. Nadal nie jest to dowód aktywacji w LLG ani
kwalifikacja runtime.

**Uzupełnienie implementacyjne 2026-09-21 (walidacja spectrum/FFT):**
Inspector `spectrum` współdzieli walidację solution reference i targetu, a
dodatkowo sprawdza opcjonalny port przypięty do stage'a. Odwzorowano reguły
IR dla sampling plane: skończony ortonormalny układ osi, dodatnie extent,
liczniki próbek, okna wymagające co najmniej trzech próbek, dozwoloną
interpolację oraz zgodność `spatial_fft`/`nonuniform_spatial_fft` z k-grid.
Dozwolone komponenty i niepusty output również są sprawdzane. Niepoprawny
request ma `Validation` i `invalid · result pending`; poprawny nadal czeka na
rzeczywisty payload FFT. Testy modelu/DOM przechodzą 13/13 (DOM 8/8), ESLint,
React Doctor i typecheck zmienionych plików pozostają bez nowych błędów.
To kontrakt authoringu, nie dowód wykonania FFT ani kwalifikacja runtime.

**Uzupełnienie implementacyjne 2026-09-21 (harness browser):** dodano
`apps/control-room/scripts/smoke-antenna-authoring-ui.mjs` oraz helper i test
kontraktu Node. Smoke ma jawnie ograniczony zakres pierwszej fazy T15:
`create → Explorer → conductor/port/solution → ready thin metadata → WebGL`
z kontrolowanymi odpowiedziami zasobów pola/katalogu. Nie jest jeszcze pełnym
`smoke-antenna-workflow.mjs`: nie wykonuje native solve, Relax/LLG,
export/reload, waveform/reuse, stale ani lifecycle field-map. Próba wykonania
21.09.2026 ma status **zaliczona dla pierwszej fazy authoring/WebGL** po
przeniesieniu frontendowych artefaktów do zarządzanego storage. Zakres i
ograniczenia tego smoke pozostają takie same: nie wykonuje on native solve,
Relax/LLG, export/reload, waveform/reuse, stale ani lifecycle field-map.

**Uzupełnienie implementacyjne 2026-09-21 (dispatcher transakcji i dowód
runtime):** pierwsze uruchomienie ujawniło `STATUS_STACK_OVERFLOW` w workerze
Tokio przy `POST /v2/sessions/current/model/transactions`. Źródłem był zbyt
duży typ przyszłości generowany przez jeden asynchroniczny match wszystkich
wariantów `AuthoringTransactionRequest`, a nie niepoprawna scena anteny.
Handler zachowuje extractor JSON i publiczny kontrakt, lecz używa
synchronicznego dispatchera z osobno boksowanym future dla każdego wariantu.
Po restarcie przez zarządzany `just control-room-v2` utworzenie sesji zwróciło
`201`, pusty `merge_patch` zwrócił `200` z `scene_revision=1`, a `/healthz`
pozostał zdrowy. Jest to naprawa runtime control-plane, nie kwalifikacja
fizycznego pola.

Pierwsza faza browser smoke zakończyła się wynikiem **pass**: conductor,
port, stage/output, katalog thin metadata i WebGL spełniły kontrakt, a manifest
zawiera rozstrzygnięte ID oraz `scene_revision`. Fixture jawnie eksponuje
`x-api-contract-version` i `etag`; cztery znane anulowane żądania GET są
rejestrowane osobno, a wszystkie inne błędy żądań kończą test negatywnie.
Wynik zapisano w `.fullmag/test-results/antenna-authoring/` jako screenshot i
manifest. T15 pozostaje częściowo otwarte: pełny workflow z natywnym solve,
Relax/LLG, FFT, export/reload, reuse i stale musi zostać wykonany przed
odhaczeniem bramki browser.

Uzupełnienie 2026-10-03: węzeł `solution` ma ograniczony podgląd pierwszych
ośmiu próbek opublikowanej bazy `H/I` i ich pozycji. Pobiera dwa zweryfikowane
binarnie zakresy `float64_le` przez typowany zasób T14, sprawdza zgodność
nośników, jednostek, liczby wartości i skończoność próbek. Wyświetlane `H/I`
ma jednostkę `A/m/A`; nie jest jeszcze `B`, polem po przemnożeniu przez przebieg
prądu ani quantity `b_zeeman_antena_1` na siatce obiektu/airboxa. Do zamknięcia
T15 nadal konieczny jest adapter geometrii i właściwy moduł `field-map`,
materializacja quantity oraz pełny browser smoke z natywnym solve.

Uzupełnienie weryfikacyjne 2026-10-03: poprzedni smoke authoringu podstawiał
gotowy manifest dla presetu, który nie ma `ConservativeCurrentView`. Planner
`bind_resolved_antenna_field_solve` taki preset odrzuca, więc pokazywanie go
jako gotowego było fałszywe. Wspólny walidator stage oznacza brak widoku w
Explorerze i Inspectorze; gotowy historyczny manifest nie przykrywa błędnego
authoringu i nie uruchamia podglądu binarnego H/I. Komenda dodania anteny
nazywa wynik draftem. Smoke sprawdza teraz właśnie odmowę ekspozycji starego
wyniku, nie udaje wykonania pola. Skrypt przeszedł kontrolę składni Node, lecz
nie został uruchomiony w przeglądarce, bo w tej iteracji nie działał serwer.
Repozytoryjny `just verify-antenna-contracts browser` wykonał **78/78** testów
Node/Vitest bez skipów, zachował tożsamość źródeł i zgodnie z kontraktem
zwrócił `not_qualified`; testy wrappera przeszły **6/6**.

Ponowna weryfikacja bieżącego drzewa 2026-10-03 przez
`scripts/verify_antenna_contracts.py`: `model` **21/21** (`pass`), `authoring`
**70/70** (`pass`) i `browser` **157/157** testów Node/Vitest bez pominięć.
Wszystkie trzy raporty potwierdzają niezmienność źródeł w trakcie testu.
`browser` nadal ma status `not_qualified`, ponieważ zestaw nie uruchamia
rzeczywistego browser E2E ani zarządzanego runtime. Raporty: `storage/runs/antenna-contracts/20261003T065648587539Z-d2cadb3e`,
`storage/runs/antenna-contracts/20261003T065709254142Z-7f06a8d6`,
`storage/runs/antenna-contracts/20261003T065828098080Z-0852e5df`.

Uzupełnienie 2026-10-03 (osobny return): walidator `AntennaPortModeIR`
nie wymaga już, aby ujemna gałąź powrotna leżała na obiekcie sygnałowym.
Każda para terminali musi leżeć na jednym przewodniku należącym do domeny
tego samego `CurrentTransport`, a dodatnia gałąź sygnałowa pozostaje na
`source_object_id`. Dopuszczenie osobnego `object_id` dla return jest ogólnym
kontraktem portu, nie wymogiem dla każdego layoutu. Domyślny szkic Control
Room używa kanonicznego `MicrostripAntennaLayout` w **jednym** obiekcie sceny
z dwiema rozłącznymi bryłami: paskiem 50 nm i przewodnikiem powrotnym 500 nm,
oddzielonymi o 30 nm. Cztery końce są wskazywane przez selektory
`antenna_terminal:{signal|return}:{local_u_min|local_u_max}`, a nie końce
dwóch niezależnych boxów. Kontrakt transakcji UI przeszedł **44/44** testów;
`cargo check -p fullmag-ir --lib` oraz `cargo check -p fullmag-plan --lib`
przeszły bez budowania testów jednostkowych. Zbiorczy kontrakt browser
przeszedł **79/79**, lecz zwrócił `not_qualified`: brak rzeczywistego browser
E2E, zweryfikowanego zamknięcia prądu, `ConservativeCurrentView` po meshingu
i natywnego solve. To poprawia topologię szkicu i usuwa sprzeczność walidatora
z jawnie oddzielnym return; nie zamyka T04, T05 ani T15. Szerokość i odstęp
metali są wartościami startowymi szkicu, nie wynikiem kwalifikacji fizycznej.
Po korekcie jednoobiektowy payload przeszedł Pythonowy round-trip scena →
builder → `MicrostripAntennaLayout`; diagnostyczny meshing OCC opublikował
**197 węzłów, 461 tetraedrów i wszystkie 4 markery** terminali. Typecheck i
bramka architektury Control Room przeszły, a kontrakt browser ponownie
przeszedł **79/79** ze statusem `not_qualified`. Wynik siatki nie dowodzi
jeszcze integracji prądu ani błędu pola.

Uzupełnienie 2026-10-03 (pełna granica przewodnika): diagnostyczny meshing
tego samego layoutu potwierdził rozłączny podział zewnętrznych ścian na
**360 ścian z markerem 1** oraz cztery markery końcowe z licznościami
**2, 2, 10, 10**. Samo przypisanie czterech elektrod nie przechodziło
`validate_fem_boundary_partition`, ponieważ pozostały brzeg nie miał
warunku. `crates/fullmag-plan/src/surface_selectors.rs::resolve_antenna_nonterminal_selector`
wybiera teraz marker nieterminalowy tylko w części `Conductor` wskazanego
obiektu, a preset dodaje `insulating_outer` na `antenna_nonterminal`.
`cargo check -p fullmag-plan --lib`, TypeScript oraz 42 testy transakcji UI
przeszły. Test Rust selektora zapisano, ale nie zbudowano wskutek bieżącego
zakazu testów jednostkowych. Kontrakt browser przeszedł **79/79** i nadal
zwraca `not_qualified`; brakuje widoku prądu, natywnego solve i bilansu
terminali. Selektor dotyczy obecnej niezależnej siatki przewodnika OCC;
nie jest dowodem poprawnego przypisania granic w dowolnej wspólnej siatce
z airboxem.

Weryfikacja tej iteracji: celowane Vitest **55/55**, ESLint zmienionych plików
bez nowych błędów, `git diff --check` **OK**. Typecheck nadal ma trzy znane
błędy nullability w `FieldMapModule.tsx:588-591`; testów jednostkowych Rust nie
kompilowano, a kwalifikacji FEM/FDM GPU nie przeprowadzono.

**Pliki:** istniejące AntennaObjectPanel/Model/test, geometry command i test, Explorer/ribbon; nowe panele w `apps/control-room/src/modules/inspector/panels/antenna/`: `AntennaConductorPanel.tsx`, `AntennaPortPanel.tsx`, `AntennaSolutionPanel.tsx`, `AntennaProjectionPanel.tsx`, `SolvedAntennaDrivePanel.tsx`, `AntennaSpectrumPanel.tsx`.

- [ ] Rozdzielić etykiety „Pole regionalne” i „Antena przewodnikowa”. Stary regional panel pozostaje edytorem regional drive; nie używać go jako fallback dla brakującej konfiguracji solved source.
- [ ] Każdy child node Explorer dostaje własny selection identity i dedykowany Inspector. Dla conductor pokazać geometrię/materiał, dla portu terminale/kierunki, dla solution status/diagnostykę, dla projection target/metodę, dla drive prąd/waveform/activation, dla spectrum plane/okno/komponent.
- [ ] Badge ready brać ze zgodnego resource, nie z `type=antenna`. Incomplete port/target ma listę konkretnych braków oraz przycisk prowadzący do właściwego panelu.
- [ ] Naprawić `draftWaveform`: podczas edycji parametrów tego samego waveform zachować istniejące phase/offset/amplitude i wszystkie inne nieedytowane pola; przy zmianie rodzaju zastosować jawne defaulty nowego rodzaju.
- [ ] Utrzymywać draft pod `(object_id, field_id)`; rewizja całej sceny nie resetuje edycji. Konflikt tego samego pola pokazuje porównanie server/draft, a niezwiązany ACK nie zmienia lokalnej wartości.
- [ ] Każdy patch pełnej tablicy musi używać oczekiwanej `base_revision`, albo zastąpić go typed command pojedynczego obiektu/portu. Nie retry’ować konfliktu przez nadpisanie nowszego dokumentu.
- [ ] Pending stan jest per-field/transaction; nie wyłączać całego Inspectora. Zachować root identity, scroll, focus i selection, bez animacji opacity na trwałych kontrolkach.
- [ ] Reuse istniejących field slices/plots. Prezentować H/A i jednostkę po konwersji; próbkowanie błędne/poza domeną ma odrębny stan. Field-map aktywny zamiast viewport-3d nie utrzymuje niepotrzebnego WebGL render loop.
- [ ] UI wybiera natywny field solve jako jawny stage i dopina drive do TimeEvolution; przejście do LLG jest niedostępne przy stale/unqualified projection.
- [ ] Uruchomić React diagnostics według `react-doctor`, a następnie realny browser smoke nowej anteny z T13/T14. Mock-only test nie zamyka F01/F09.

Obowiązkowe scenariusze testów modelu panelu:

```text
existing sinusoidal phase=0.7, offset=0.2; edit only B amplitude -> phase=0.7, offset=0.2
existing sinc amplitude=0.3; edit only direction -> amplitude=0.3
unsaved current draft; unrelated object revision -> draft unchanged
edit current pending; click frequency -> frequency control remains enabled and focused
two concurrent add commands -> revision conflict or both objects preserved; never silent overwrite
new conductor antenna -> port/solution Inspector; never missing regional source panel
```

**Bramka:** `browser`. Nowy smoke `smoke-antenna-workflow.mjs` wykonuje create → solve → inspect H → Relax/Run → inspect m → export/reload → change waveform/reuse → change geometry/stale. Sprawdza widoczny canvas, `gl.isContextLost() === false`, niezerowy drawing buffer oraz osobny lifecycle field-map. Commit: `feat: complete conductor antenna authoring and inspection`.

## T16. Udostępnić FEM precompute → FDM CPU i GPU

Uzupełnienie 2026-10-02 (tożsamość siatki celu): materializacja FDM i
walidacja przed CPU/GPU runtime liczą teraz wspólny digest fizycznego origin,
liczby i wielkości komórek, region mask oraz active mask. Rozwiązana baza
anteny bez zgodnego `:target_topology:` w `projection_signature` jest
odrzucana nawet przy tej samej liczbie próbek. Dodano regresję źródłową
przesunięcia siatki i poprawiono fixture CPU. Nie uruchomiono unit testów
zgodnie z `AGENTS.md`; nie jest to dowód kwalifikacji żadnej lane.

**Pliki:** CLI attach, planner FDM/antenna projection, `crates/fullmag-runner/src/fdm/cpu/reference.rs`, `fdm/gpu/cuda/native.rs`, `multilayer.rs`, właściwi natywni właściciele FDM regional field oraz publiczne ABI.

- [ ] Zdefiniować backend-neutral resolved sampled basis z target certificate, jednostką H/A, waveform i time origin. Requested LLG backend nie zmienia backendu historycznego solve anteny.
- [ ] W T09 wygenerować projekcję na rzeczywiste cell centers FDM, z maską Ms/geometry i kolejnością zgodną z planem. Dla multilayer uwzględnić grubości, położenia i aktywne komórki; nie zakładać jednego równego z-grid.
- [ ] Domknąć istniejący CPU helper przez publiczny CLI zamiast pozostawiania go niewywołanym. Test ma uruchamiać prawdziwy skrypt pipeline, nie tylko konstruować FdmPlan ręcznie.
- [ ] Uzyskać CPU oracle statycznego H i krótkiej LLG. Potem dodać upload bazy do istniejącego natywnego właściciela pola FDM CUDA i ocenę waveform na urządzeniu/czasie RK zgodnie z jego kontraktem.
- [ ] Nie kopiować całej bazy przy każdym RHS; upload po zmianie projection revision. W idle/rendering nie przeliczać pola anteny.
- [ ] Forced GPU przy braku kwalifikacji kończy się jawnym błędem. Zlikwidować istniejące odrzucenie w CLI dopiero gdy plan, upload, waveform, quantity i runtime proof są kompletne.
- [ ] Zweryfikować double najpierw; single pozostaje unavailable dla tego workflow do własnych tolerancji i parity. Multilayer nie dziedziczy automatycznie kwalifikacji single-grid.
- [ ] Dla FEM GPU wykonać osobny test tego samego artefaktu i RK. Wspólne pakowanie CPU/GPU nie zastępuje dowodu GPU device identity.

**Bramki w kolejności:** `fdm-cpu`, `fdm-gpu`, `fem-gpu`. Każda zapisuje source/target hashes, device ordinal/name, precision, integrator, statyczne pole i trajektorię. Publikować support tylko dla kombinacji faktycznie zaliczonych; reszta ma jednoznaczny komunikat w UI i Python.

Uzupełnienie runtime 2026-09-12: istniejący FDM CPU/reference ma zielone testy
skalowania rozwiązanej bazy przez prąd i oceny waveformu w czasie oraz test
braku RF w relaksacji. Publiczny skrypt pipeline, projekcja na rzeczywiste
komórki FDM, upload CUDA i osobne dowody GPU nadal nie są zamknięte.

Uzupełnienie runtime 2026-09-21: naprawiono rozjazd zegara w ścieżce FDM
CUDA dla rozwiązanego napędu regionalnego/antenowego. Natywny integrator ma
zegar lokalny od zera, dlatego granica CUDA mapuje `stage_local` na
`t_solver`, a `absolute` na `t_solver + stage_start_time_s`; snapshoty `H_ant`,
live preview i rekonstrukcja energii używają tego samego mapowania. Zmiana nie
kwalifikuje jeszcze GPU: nadal brakuje kontenerowego dowodu double parity,
pełnej trajektorii LLG i testu rzeczywistego runtime.

Uzupełnienie runtime 2026-09-21 (granice waveformu): CUDA przycina teraz
stały i adaptacyjny krok do granic `pulse`/PWL zarówno dla `field_drives`, jak
i aktywnych `solved_antenna_drive_bases`. Harmonogram jest liczony w czasie
fizycznym i konwertowany na lokalny zegar native; nie zmienia kroku dla
sinusoidy ani sinc, które są ciągłe. Nadal potrzebny jest kontenerowy test
RHS/trajectory z rzeczywistym skokiem waveformu.

## T17. Domknąć frequency response bez pozornego wsparcia eigenmodes

**Pliki:** `crates/fullmag-runner/src/frequency_response.rs`, CLI attach/resolver, IR study/drive, planner frequency response i źródła wymuszenia.

- [ ] Rozdzielić dwa użycia: statyczne pole wpływające na równowagę/operator oraz małosygnałowe wymuszenie frequency response. Solved dynamic drive nie jest samodzielnym eigenmode operator.
- [ ] Dla rzeczywistej bazy Tier 1 dopuścić w frequency response harmonijny skalarny prąd z jawną fazą. Uzgodnić konwencję exp(+/-i omega t) z istniejącym właścicielem frequency_response i przeliczyć Sinusoidal dokładnie do niej.
- [ ] Odrzucić pulse/sinc/sampled waveform w steady harmonic study, chyba że jest jawny osobny kontrakt transformaty sygnału; nie interpretować ich amplitudy jako sinusoidy automatycznie.
- [ ] Wczytać i sprawdzić equilibrium oraz target projection; skonstruować RHS z wektorowego pola przez istniejący operator liniaryzacji LLG, zachowując jednostki i damping policy.
- [ ] Usunąć blanket rejection `FemFrequencyResponse` dopiero po wykonaniu rzeczywistego rozwiązania. `FemEigen` nadal jawnie odrzuca aktywne dynamiczne wymuszenie, bo nie jest to problem własny z prawą stroną.
- [ ] Porównać harmoniczną odpowiedź macrospin z analityką i z FFT długiej małoamplitudowej trajektorii T13 po odrzuceniu transjentu. Porównać także fazę, nie tylko peak frequency.
- [ ] Zapisać rozróżnienie pola na amper, odpowiedzi na podany prąd i susceptibility. Nie nazywać odpowiedzi magnetyzacji S21 bez modelu detektora.

**Bramka:** `frequency-response`. Jeśli bieżący scope produktu ma kończyć się na time-domain, etap może pozostać jawnie unavailable, ale nie wolno wtedy oznaczyć tej pozycji planu jako zamkniętej ani opisać całego docelowego scope jako gotowego.

(plan-validation)=
## T18. Domknąć dokumentację, walidację i ponowny audyt

Uzupełnienie 2026-10-06: pierwszy blok sekcji `antenna-python-api` noty 0950
zastąpiono literalnym aktualnym `examples/fem_antenna_current_source_inspection.py`.
Test `packages/fullmag-py/tests/test_antenna_documented_example.py::class AntennaDocumentedExampleTests`
sprawdza kopię, składnię, rzeczywiste lowering i export/reimport z tymi samymi
assetami; RED 1 FAIL/1 ERROR → GREEN 2/2 PASS. Ten authoring nie uruchamia
solvera. Wyjście pozostaje inspection-only raw H w A/m, nie baza H/A;
osobny magnetyczny probe nadal wymagany przez obecny carrier sesji.
Pełny przykład zakwalifikowanej bazy, projekcji, waveform i późniejszego LLG/FFT,
całość tabel publicznych parametrów oraz końcowa publikacja nadal otwarte.
Checklisty poniżej nie oznaczono jako zakończonej na podstawie tego przyrostu.
R1 seq 34 ma pełny terminalny odbiór PASS; R3 seq 35 running.

Historyczne uzupełnienie 2026-10-03: skupiony walidator noty 0950 i jej source-map
przeszedł bez błędów, a testy kontraktu dokumentacji naukowej przeszły
**32/32**. Starszy wpis o czterech błędach walidatora nie opisuje już
bieżącego worktree; nie oznacza to ukończenia T18. Pierwszy przykład w 0950
nadal jest jawnie oznaczonym celem projektowym, nie wykonywalnym skryptem
stage-first. Macierz source-map skorygowano z „not implemented” do
`implementation_unqualified` dla ścieżek, które mają już kod, ale nie mają
dowodu natywnego workflow i parytetu urządzeń. Zarządzany runner zwraca
`Container configuration is missing`; brak kontenera nie upoważnia do
hostowej deklaracji kwalifikacji FEM.

**Pliki:** 0950/source-map, 0980/source-map jeśli zmienia się current/Oersted, ADR 0017, capability matrix, Python public docs, `docs/validation/antenna/`, niniejsza macierz coverage i nowy raport końcowy.

- [ ] Zastąpić target-only przykład 0950 aktualnym wykonywalnym stage-first skryptem. Tabela parametrów musi obejmować wszystkie publiczne klasy i pola antenowe, w tym waveform, projection, sampling i requested/resolved semantics.
- [ ] Rozwiązać cztery błędy validatora odnotowane w audycie poprzez rzeczywiste uzupełnienie tabel/mapowania, nie przez usunięcie parametrów z source-map. Sprawdzić wszystkie nowe kotwice path+symbol.
- [ ] Wygenerować pełne golden JSON z bieżących przykładów, zrealizować export/reimport UI i zapisać zgodność intent. Nie ręcznie pisać wygodniejszego JSON niż produkuje DSL.
- [ ] Uruchomić wszystkie grupy verification, właściwe native gates, typecheck/API hygiene, browser i scientific-docs validators. Publiczne strony budować Sphinx z warnings-as-errors oraz sprawdzić rendered HTML według scientific-documentation-contract.
- [ ] Wykonać CPW wide/constricted benchmark: fixed targets, trzy siatki, lokalne widmo, odpowiedź m(k,omega), niezależna dyspersja i analiza wpływu tłumienia. Nie używać sztucznie zmniejszonego damping do deklaracji rzeczywistej długości propagacji.
- [ ] Zapisać osobną macierz CPU/FDM, GPU/FDM, CPU/FEM, GPU/FEM z integratorami i precyzjami; brak danych lub skip pozostaje not_qualified.
- [ ] Powtórzyć audyt wszystkich F01–F13 i luk scope. Każdy wiersz ma wskazywać commit, test reprodukujący błąd, wynik RED przed i GREEN po, raport runtime jeśli wymagany.
- [ ] Wykonać końcowy read-only review diffu względem aktualnego master. Potwierdzić, że nie usunięto zmian mixed-mesh, frozen spins, profiler ani zasad output directory.
- [ ] Przygotować opis integracji z konkretnym zachowaniem przed/po i rzeczywistymi wynikami. Nie scalać automatycznie ani nie publikować dokumentacji na podstawie samego odhaczenia listy.

Polecenia dokumentacyjne istniejące w repo:

```text
python -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.source-map.json --repo-root .
python -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0980-dynamic-current-and-oersted-coupling.source-map.json --repo-root .
python -B -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p "test_*.py"
python -B scripts/check_public_doc_examples.py --root public_docs/site
just verify-antenna-contracts all
```

`python` w tych poleceniach oznacza istniejący zweryfikowany interpreter z T01; na badanym Windows użyto `D:/fullmag-cache/contract-python/Scripts/python.exe`, ponieważ systemowy alias `python.exe` nie działał. Nie instalować nowego środowiska w checkoutcie.

(plan-python-api)=
(plan-problem-ir)=
(plan-round-trip-and-failure-semantics)=
## 4. Kontrakty przekazania między zadaniami

| Producent → konsument | Co przekazuje | Czego nie wolno zakładać |
|---|---|---|
| T02 → T03/T05 | Wersjonowane terminal pairs, podpisane wagi i normę 1 A | Pojedynczy legacy terminal nie określa pełnej gałęzi |
| T03 → T08/T12 | Symboliczny stage/output jako requested intent | Authoring nie zna jeszcze digestu rozwiązania |
| T05 → T06 | V/J i podpisany terminal certificate/gauge | Bilans modułów nie jest bilansem znaków |
| T06 → T08 | Konserwatywny source i pole z raportem dokładności | Mała reszta solvera nie jest błędem pola |
| T08 → T09/T13 | Resolved execution, integralność i aktualne signatures | Stary poprawny plik nie musi pasować do nowego modelu |
| T09 → T10/T13/T16 | Pole w target ordering, maska, metoda i scope | Missing sample nie jest outside_domain |
| T07 → T13/T16 | Aktywne termy i poprawny waveform/time origin | AllTimeEvolution nie obejmuje Relax |
| T12 → T14 | Rzeczywisty stage status i revisioned artifact refs | Enum postępu nie jest pomiarem pracy |
| T14 → T15 | Typowany facade/resource model | UI nie składa własnych URL ani fizyki |

`validation errors` muszą pozostać rozpoznawalnymi kategoriami z identyfikatorem obiektu/portu/stage. `unsupported combinations` mają failować przed pracą i być widoczne przez ten sam capability contract w Python i UI. Wersjonowane zmiany authoringu i ABI są częścią T02/T03/T05/T09, nie bezterminowym dual stack.

(plan-discrete-realization)=
## 5. Macierz finalnych dowodów i odpowiedzialności

| Lane | Solve pola | Konsumpcja LLG | Wymagany dowód |
|---|---|---|---|
| FEM CPU | Native H1/hypre, RT0, adaptive Biot–Savart | Natywny Zeeman | T05/T06/T13, urządzenie CPU i właściwy build |
| FEM GPU | Pierwszy solve nadal jawnie CPU | Własna realizacja device runtime | T16, artifact identity i GPU trajectory; nie nazywać precompute GPU |
| FDM CPU | Import wyniku FEM | CPU oracle na cell centers | T09/T16, projection error i LLG |
| FDM GPU | Import wyniku FEM | CUDA field-basis owner | T16, double parity, poprawny RK i brak transferów per-RHS |

Każda promocja jest osobna. Nie ma automatycznej zasady „native ABI istnieje, zatem wszystkie backendy są gotowe”.

(plan-limitations)=
## 6. Czego ten plan nie wdraża

Pełne Maxwell, harmoniczna zależność profilu J od częstotliwości, S-parametry, dBm normalization, detektor indukcyjny, backreaction i automatyczny obwodowy rozdział prądów RF to dalsze projekty. Plan naprawia wszystkie znalezione problemy Tier 1 i przygotowuje do nich uczciwe granice kontraktów. Nie udaje, że implementacja tych rozszerzeń jest potrzebna do naprawienia gubienia sceny lub aktywacji Relax.

Wykonanie T00–T18 może wymagać kilku przeglądanych zmian, a nie jednego ogromnego commita. Nie wolno zamknąć audytu połową przepływu ani nazwać testów source-layout kwalifikacją fizyczną. Jeśli środowisko blokuje runtime, zadanie otrzymuje status niezweryfikowane wraz z konkretnym poleceniem i błędem; nie obniża się wymagań.

## 7. Lista odbioru planu

- [ ] F01–F13 mają test przez rzeczywistą wadliwą granicę oraz poprawkę właściciela.
- [ ] Każda luka scope ma właściciela w T00–T18; nie ma niejawnie odłożonego FDM/phase/round-trip.
- [ ] Wszystkie nowe pliki/types/recipes są jawnie nazwane jako planowane; istniejące paths zostały sprawdzone.
- [ ] Native build jest kontenerowy i ma zewnętrzne storage; testy nie przechodzą z liczbą 0.
- [ ] Przykłady publiczne są stage-first i wykonane, a dokumentacja rozróżnia plan od faktycznej lane qualification.
- [ ] Frontend przechodzi realny browser smoke, stabilność Inspectora i WebGL lifecycle.
- [ ] Reviewer otrzymuje dowody numeryczne, nie wyłącznie listę plików lub screenshot.

(plan-scientific-bibliography)=
## 8. Dokumenty nadrzędne i źródła

- [Audyt F01–F13](../../audits/2026-09-08-microwave-antenna-worktree-audit.md): diagnoza, rewizje, dowody i granice walidacji.
- [Fizyka 0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md): właściciel modelu źródła, SI, normalizacji i ważności.
- [ADR 0017](../../adr/0017-staged-antenna-field-basis-workflow.md): stage-first solve i reuse bazy.
- [Projekt field-basis](../specs/2026-07-10-microwave-antenna-field-basis-design.md): docelowe funkcje produktu; jego fragmenty historyczne wymagają aktualizacji do wyników audytu.
- [Backend masterplan](../../architecture/backend-golden-masterplan.md): właściciele native physics i runtime.
- [Höfinger i in.](https://arxiv.org/html/2511.10346v1), [Gruszecki i in.](https://arxiv.org/abs/1509.05061), [MIT Skin Effect](https://www.mit.edu/course/6/6.013_book/www/chapter10/10.7.html): źródła naukowe omówione z ograniczeniami w audycie.

(plan-source-code-index)=
## 9. Kotwice kodu dla wykonawcy

| Ścieżka istniejąca | Symbol | Zadania |
|---|---|---|
| `crates/fullmag-cli/src/orchestrator.rs` | `read_ready_antenna_stage_outputs` | T08/T12: referencja dopiero po pełnej integralności assetu i porównaniu manifestu; runtime otwarty |
| `crates/fullmag-runner/src/antenna_stage.rs` | `load_published_antenna_field_solution_for_port` | wspólny integrity gate i obecność portu, nie current-model freshness |
| `scripts/test_antenna_catalog_asset_source.py` | `class AntennaCatalogAssetSourceTests` | source RED2 → GREEN2/2, nie wykonanie Rust |
| `crates/fullmag-runner/src/antenna_stage.rs` | `catalog_port_loader_checks_integrity_before_port_membership` | zapisany niewykonany test Rust, positive canonical fixture / wrong port / corrupted payload |
| `crates/fullmag-runner/src/antenna_stage.rs` | `inspect_cached_antenna_field_solution` | T08/T12: ready cache przechodzi silną kontrolę aktualnego źródła; WIP, runtime otwarty |
| `scripts/test_antenna_cache_expectation_source.py` | `class AntennaCacheExpectationSourceTests` | source-only cache/revision/target/race guards; nie wykonanie Rust |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-consumer-activation-preflight` | source commit i WIP lazy-root/clear-bases; pełne domknięcie i runtime otwarte |
| `crates/fullmag-cli/src/orchestrator.rs` | `prepare_solved_antenna_drive_activation` | wspólna validation i clear nieaktywnych/pustych baz |
| `scripts/test_antenna_activation_preflight_source.py` | `class AntennaActivationPreflightSourceTests` | source parent RED3 → INDEX3/3, bez Rust |
| `scripts/test_antenna_observation_source.py` | `test_consumer_validates_activation_before_resolving_artifact_root` | lazy-root WIP regression, nie wykonanie solvera |
| `scripts/test_antenna_observation_source.py` | `test_activation_preflight_clears_inactive_or_absent_bases_in_both_lanes` | clear obu lane przed false, source-only |
| `scripts/test_antenna_observation_source.py` | `test_attachment_preserves_strong_loading_after_the_shared_activation_gate` | zachowanie silniejszej granicy full WIP |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-build36-terminal-package-acceptance` | terminalny trusted pakiet126artefaktów/kapsuła7453, nie aktualny HEAD/runtime/fizyka |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-observation-readiness-commit` | źródłowo naprawiony energy no-op; runtime/rollback/basis nadal otwarte |
| `scripts/test_interactive_observation_readiness_source.py` | `InteractiveObservationReadinessSourceTests` | source RED parent5tests6failures → INDEX5/5, bez Rust/native |
| `crates/fullmag-cli/src/interactive_runtime_host.rs` | `ensure_base_runtime_ready` | fallible preparation wspólne dla fields/energies/import |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-command-result-correlation-commit` | commit compute/import, source 8/8; Rust/runtime i no-op energy otwarte |
| `scripts/test_command_result_identity_source.py` | `CommandResultIdentitySourceTests` | wykonane niezależne RED parent / GREEN INDEX; nie test solvera |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-r3-fixed-ram-comparison` | T12: wykonany fixed V/RT0/H RAM, nie full physics/reuse qualification |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-r3-package-openapi-acceptance` | T12: odbiór R3/package/API, nie runtime/fizyka ani nowy handoff |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-scripted-interactive-output-handoff` | T10/T12: finalny szablon i nowy stage, 29/29 source; runtime otwarty |
| `scripts/test_antenna_observation_source.py` | `test_each_interactive_stage_resolves_before_new_sequence_plan_and_attachment` | ordering nowej sequence/plan/load, nie atomicity całego resume |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-retained-native-tolerance-bit-evidence` | T12: 4/4 retained tau bits PASS, nie pełny libm parity/provenance ani R3 qualification |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-libm-parity-counterexample` | T12/R2: 57 niezgodnych tolerance w diagnostyce GNU libm/Python; required jawna realizacja normy, nie zmiana progów |
| `apps/control-room/scripts/normalize-openapi-build-identity.mjs` | `validateManagedSnapshotOpenApiReceipt` | T12: wykonane raw/receipt/proof binding przed normalization; nie kwalifikacja R3/runtime/nauki |
| `crates/fullmag-authoring/src/scene.rs` | `SceneDocument` | T03 |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx` | `TransportAuthoringInspector` | T15: scoped draft/ACK, exact revision i jawny rebase |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts` | `reconcileTransportDraft`, `transportDraftValuesEqual`, `currentTransportDraft` | T15: merge draftu i lokalne ID source cuts bez zmiany wire schema |
| `justfile` | `verify-antenna-transport-drafts-browser` | T15: current transport browser fixture, nie native ani science gate |
| `apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditor.tsx` | `MicrostripGeometryEditor` | T15: lokalne ID, baza draftu po ACK, scoped publikacja sceny |
| `apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts` | `widthStationDraft`, `widthStationsEqual`, `buildMicrostripGeometry` | T15: unikalne klucze UI bez zmiany fizycznego JSON |
| `justfile` | `verify-antenna-microstrip-stations-browser` | T15: browser fixture, nie native ani science gate |
| `crates/fullmag-authoring/src/adapters.rs` | `scene_document_from_script_builder` | T03 |
| `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` | `apply_scene_merge_patch` | T03/T14 |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaPortMode` | T02/T03 |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class SolvedAntennaDrive` | T03/T07 |
| `crates/fullmag-plan/src/antenna_composition.rs` | `bind_resolved_antenna_field_solve` | T05 |
| `crates/fullmag-runner/src/native_fem/charge_transport.rs` | `measured_port_current` | T05 |
| `crates/fullmag-ir/src/field_drive_validation.rs` | `validate_time_dependence` | T07 |
| `crates/fullmag-plan/src/util.rs` | `field_drive_is_active` | T07 |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `load_solved_antenna_drive_basis_projected` | T08/T09 |
| `crates/fullmag-runner/src/antenna_stage.rs` | `antenna_field_solution_signatures` | T08 |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `sample_antenna_field_on_plane` | T09/T10 |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `compute_structured_antenna_source_spectrum` | T10 |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `compute_nonuniform_k_antenna_source_spectrum` | T10 |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport_rt0` | T06/T11 |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `solve_rt0` | T06/T12: required pełny bounded eksport v3 diagnostics |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-global-target-v3-fixed-ram-evidence` | T06/T12: siódmy fixed outside-source RAM V/RT0/H PASS; odrębny od otwartych regular publication/load/verifier gates |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `validate_direct_oersted_convergence` | T06/T12: required typed v3 acceptance zamiast historycznych scalars |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `build_antenna_field_solution_artifacts`, `StoredBasisManifest` | T06/T09/T12: required diagnostics publication/load i raw/per-A binding |
| `tests/antenna/verify_field_convergence.py` | `read_solution_checked` | R2 wykonany reader v3 i jawny legacy opt-in; native/provenance qualification otwarte |
| `tests/antenna/direct_quadrature_evidence.py` | `verify_direct_evidence` | niezależny raw/ledger/binding parser i odmowy po rehash, nie native scientific proof |
| `scripts/export_runner_openapi.py` | `_validate_managed_build` | explicit exact snapshot/clean admission i pełne receipt/capsule gates; realny odczyt R1, nie schema R3 |
| `scripts/test_export_runner_openapi.py` | `test_explicit_snapshot_export_binds_both_digests_and_actual_dirty_state` | wykonana interpretowana regresja dokładnych pinów i dirty proof; nie naukowy test anteny |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `extern "C" int fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1` | T06/T12: nowy source-only pełny ledger eksportowany z jednego solve; adapter nadal required |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-global-target-v3-regular-export-contract` | R1/R3: append-only raw snapshot, normalizacja bez floating-point round-trip i bounded binary evidence; nie qualification |
| `crates/fullmag-cli/src/orchestrator.rs` | `attach_solved_antenna_drive_bases` | T08/T12/T16/T17 |
| `crates/fullmag-runner/src/native_fem.rs` | `pack_native_regional_field_drives` | T07/T13 |
| `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp` | `project_regional_field_drive_bases` | T00/T13 |
| `examples/fem_antenna_current_source_inspection.py` | `lead_cubes` | T05/T06/T12: nowy publiczny input bez Relax/Run; native NOT VERIFIED |
| `packages/fullmag-py/tests/test_antenna_current_source_example.py` | `test_script_export_preserves_source_port_target_and_stage` | T03/T12: interpretowany export/reimport z prawidłowym source root |
| `scripts/run_managed_browser.py` | `validate_managed_build` | T12: dokładny snapshot i integralność pakietu; runtime NOT VERIFIED |
| `scripts/test_run_managed_browser.py` | `test_run_refuses_capsule_mismatch_before_docker_or_storage_initialization` | T12: odmowy przed Dockerem i zapisem storage, nie dowód solvera |
| `scripts/antenna_current_source_oracle.py` | `compare_fixture` | T05/T06/T12: pinned, gauge-free V i niezależne modeled H; native NOT VERIFIED |
| `scripts/run_managed_antenna_ram.py` | `start`, `observe`, `attest` | T12: zatwierdzona sesja naukowa w RAM, izolacja i dokładny build/input binding; runtime NOT VERIFIED |
| `scripts/antenna_inspection_export.py` | `read_inspection`, `manifest_digest` | T06/T12: bounded integralność exact exportu; nie authoritative native decoder ani kwalifikacja |
| `scripts/compare_managed_antenna_ram.py` | `compare`, `reconstruct_inputs` | T05/T06/T12: binding konkretnego runu, kapsuły, staged input i V/H; native porównanie NOT VERIFIED |
| `scripts/test_compare_managed_antenna_ram.py` | `test_uses_exact_run_values_and_never_promotes_scope` | T12: interpretowana orkiestracja i brak promocji qualification; nie wykonanie solvera |
| `packages/fullmag-py/src/fullmag/runtime/run_config_export.py` | `_runtime_stage_action` | T03/T12: referencyjna akcja CLI i definicja bieżącego solve w stage IR, bez future leakage |
| `packages/fullmag-py/tests/test_antenna_current_source_example.py` | `test_multi_stage_run_config_never_imports_future_solve_definitions` | T03/T12: pełny export wcześniejszego Run i dwóch solve; nie wykonanie fizyki |
| `packages/fullmag-py/tests/test_antenna_run_config_export.py` | `test_runtime_export_materializes_only_the_current_definition` | T03/T12: samodzielna regresja serializacji z izolowanym HEAD RED→GREEN, nie model solvera |
| `scripts/test_antenna_inspection_export.py` | `test_same_size_payload_mutation_is_rejected` | T06/T12: syntetyczne odmowy mutacji pięciu payloadów; nie native proof |
| `scripts/test_run_managed_antenna_ram.py` | `test_real_build_binding_rejects_same_size_byte_mutations` | T12: rzeczywisty validator pakietu/kapsuły; nie wykonanie solvera |
| `scripts/test_antenna_current_source_oracle.py` | `test_reduced_integral_matches_independent_three_dimensional_cubature` | T05/T06: interpretowany niezależny wzorzec całki 3D, nie wykonanie solve |

Kotwice mogą się zmienić po T00; wykonawca aktualizuje mapę źródeł przy przeniesieniu symbolu. Zaplanowana nazwa nowej funkcji nie jest dowodem obecności jej implementacji.
