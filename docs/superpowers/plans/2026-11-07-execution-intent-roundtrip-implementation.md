# Zachowanie intencji wykonania w eksporcie — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Zachować tryb interaktywny i oczekiwanie na Compute w capture, canonical Python, scenie UI, live authoringu oraz wspólnym kompilatorze etapów.
**Architecture:** Naprawiamy istniejących właścicieli authoringu, bez nowych pól fizycznych ProblemIR i bez drugiego runtime. Dwa opcjonalne pola na poziomie study przechodzą przez typy Rust/Python; migawki etapów używają istniejących map extra/payload. Renderer odtwarza ustawienia przed każdym etapem i końcowy stan workspace po deklaracjach.
**Tech Stack:** Python DSL/unittest, Rust serde i istniejący kompilator pipeline, API v2 oraz obecne testy Vitest.
**Spec:** [Raport reprodukcji](2026-11-07-antenna-capture-intent-regression-audit.md) oraz [kontrakty aplikacji](../../../.agents/instructions/contracts.md), sekcje 4, 10 i 13.
**Status:** ZATWIERDZONY 07.11.2026; implementacja źródłowa i lekki odbiór wykonane. Testy Rust/API oraz CI42365723712 przeszły; odbiór managed pozostaje niewykonany. Bez zgody na nowy Solve, restart lub zwolnienie rezerwacji. [Raport wykonania](2026-11-07-execution-intent-roundtrip-result.md).

Zatwierdzona wersja planu jest zachowana w commicie e5c94c31a5899b5b8a16e32869012470429de0e2, SHA256 b79c14a7a520cdeca04fcb2ce64c7a22930b19393c148959f198ae914d193b9f. Poniższa lista zawiera również wymagane, jeszcze niewykonane bramki.

## Global Constraints

- Zachować istniejący worktree anten i chronione 63 wpisy indeksu; commitować tylko dokładny zakres zadania.
- Nie zmieniać równań, SI, geometrii, prądów, V/J/H, progów kwalifikacji, budżetów siatki, źródeł archiwalnych ani danych użytkownika.
- Nie zmieniać wyboru bramek CLI: wait czytany z pierwszego etapu, keep-alive z ostatniego; headless oraz jawne flagi launchera zachowują dotychczasowe pierwszeństwo.
- Zachować domyślne pomijanie wait=False w _build_problem i priorytet _extra_runtime_metadata. Nie dodawać stanu explicitness.
- Nie dodawać endpointu, drugiego klienta API, kontrolek Inspectora ani szerszego typowania całej mapy SceneResource.study.
- Wszystkie buildy wyłącznie we właściwej grupie Docker i przez istniejące recepty. Lokalnie nie kompilować testów jednostkowych Rust; wymagane CI jest dozwolone, logowanie GH odnowiono; CI poprzedniej bazy nie kwalifikuje nowego kodu.
- Ten plan nie obejmuje nowego Solve, prepare-only corner25, restartu na ślepo ani zwolnienia quarantine. Decyzja corner25 pozostaje osobna.
- Dokumentacja po polsku; kod i komentarze po angielsku. Dokument opisuje kontrakt authoringu, nie nową fizykę. Stosować scientific-documentation-contract dla dokumentacji Python/IR/runtime i jawnie oznaczyć brakujące dowody.

## Review Focus

1. Brak pola musi zachować intencję script-backed źródła, a jawne False ją wyłączyć; nie stosować truthiness.
2. Różne flagi pierwszego, ostatniego etapu i końcowego workspace nie mogą zostać spłaszczone.
3. Live whitelist, eksport anteny i zagnieżdżone pipeline groups muszą zachować te same wartości.
4. Prawdziwe zmiany geometrii/materiału i inne niedozwolone klucze nadal mają powodować odmowę.
5. Odmowa walidacji nie może pozostawić częściowo zmienionej intencji w mutowalnym current_ir.

## Potwierdzone dowody i powód pełnego zakresu

Nowy ślad publicznego export-run-config --skip-geometry-assets:
- dwa zwykłe etapy nieinteraktywne po canonical export dostają interactive=True;
- dwa interaktywne etapy są odrzucane jako zmiana geometrii, choć sygnatury różni tylko wait_for_solve;
- legacy capture True → False jest odrzucany przez tę samą bramkę;
- prawdziwa zmiana Ms różni sygnaturę materials i nadal poprawnie powoduje odmowę.

Ślady w istniejącym control volume, pod
/opt/fullmag/control/verification/antenna-authoring-roundtrip-20261107/:

| Artefakt | SHA256 |
|---|---|
| public-config-stage-trace-v2/verification.json | 014d69a4b32ceb3ba5ee2b19582a586c743898368c6ec4532d48c5d95147f203 |
| stage-compatibility-attribution-v1/verification.json | 0c608964dab18ee9b5534555a63355c7e28020567ade0cb39a44e1d64724f84d |
| raw-multistage-export-baseline-v1/verification.json | a68bd1a6e4c89fa283abb565a7362f647e67d8c4f33cfaefc3da329ff9f8b1f1 |

Pierwszy trace-v1 przerwał się na rzeczywistej odmowie eksportu. V2 zapisuje odmowy jako wyniki; nie obchodzi guardu.
Nie wykonano solvera, generowania meshu ani produkcyjnej edycji kodu.
Bazowy wieloetapowy eksport zachował typy tekstu "false", liczby 0 i None oraz wait=1 we wszystkich sześciu próbach full/thin. To wymaganie regresji, nie dopuszczenie takich wartości w typowanej scenie.

## Kontrakt danych i zgodność

| Pole / nośnik | Typ | Brak | False / True | Jednostka |
|---|---|---|---|---|
| ScriptBuilderState.interactive_session_requested | Option<bool> | brak nadpisania źródła | jawna deklaracja | 1 |
| SceneStudyState.interactive_session_requested | Option<bool> | nowa scena: domyślne False; script-backed: bez zmiany | jawna deklaracja workspace | 1 |
| ScriptBuilderState.wait_for_solve | Option<bool> | brak nadpisania źródła | jawna deklaracja | 1 |
| SceneStudyState.wait_for_solve | Option<bool> | zachowanie dotychczasowej reguły auto-wait | jawna wartość ma pierwszeństwo przed auto-wait | 1 |
| te same klucze w stage.extra / primitive.payload | opcjonalny JSON bool | dziedziczenie istniejącego stanu etapu | nadpisanie bezpośrednio przed etapem | 1 |

Flagi opisują kontrolę wykonania, nie fizykę ani solver. Nie ma przeliczeń jednostek.
wait=True przy interactive=False pozostaje dopuszczalne.

- Typowana scena odrzuca null, tekst, liczby, tablice i obiekty. Rust używa Option<bool> z default dla braku i deserializatorem wymagającym bool dla obecnego klucza.
- JSON Merge Patch null usuwa klucz przed walidacją dokumentu zgodnie z istniejącą ścieżką; to nie jest zapis null do pola.
- Wyeksportowana z poprawnego skryptu scena zapisuje skuteczne booleany dla workspace oraz każdej migawki etapu. Brak wait w istniejącej migawce oznacza skuteczne False, nie nową politykę CLI.
- Nadpisania explicit stage mają pierwszeństwo przed domyślną wartością study. Brak stage key zachowuje dotychczasowy current_ir.
- Dotychczasowy surowy runtime_metadata i export-run-config --runtime-flags-only zachowują wartości/typy. Nie naprawiać "false" do False. Gdy użytkownik żąda typowanej sceny lub wykonania nowego payloadu z niebooleanem, zwrócić konkretny błąd tej granicy.
- Stare dokumenty bez kluczy pozostają czytelne. SceneStudyState ma deny_unknown_fields: STARY runtime odrzuci nowy dokument z tymi polami. To zgodność wstecz odczytu, nie zgodność nowego dokumentu ze starym runtime.
- Nie podnosić globalnie wersji ProblemIR. Nowe dokumenty wymagają spójnego pakietu authoring/API/Python. Ewentualny rollback starszego pakietu wymaga zachowanej wersji projektu sprzed nowych pól; nie usuwać pól automatycznie.
- Wyniki naukowe i ich dawne statusy/provenance nie są migrowane. Nowe flagi są zapisywane z nową rewizją authoringu i widoczne w wyeksportowanym skrypcie.

## Mapa plików i właścicieli

| Plik | Odpowiedzialność zmiany |
|---|---|
| packages/fullmag-py/src/fullmag/world.py::capture_workspace_problem | usunąć wymuszenie interactive=True bez zmiany _build_problem |
| packages/fullmag-py/src/fullmag/runtime/execution_intent.py — nowy | wspólna walidacja obecnych bool i odczyt skutecznych bool |
| runtime/script_builder.py::export_builder_draft, _export_stage_draft_with_identity, _export_study_pipeline_node | top-level oraz rzeczywiste migawki etapów; zachować flagi w zastępowanym draft anteny |
| runtime/script_builder.py::_render_runtime, _render_stages, _render_scene_document_bootstrap, render_loaded_problem_as_script | odtwarzanie per-stage przed każdą deklaracją/akcją i finalnych flag po deklaracjach |
| runtime/script_builder.py::_stage_signature | usunąć wyłącznie dwa klucze kontroli po wdrożeniu pełnego odtwarzania; zachować fizyczny guard |
| runtime/scene_document.py::build_scene_document_from_builder, build_builder_from_scene_document, builder_overrides_from_scene_document | walidacja, obecność i przeniesienie flag study oraz stages |
| runtime/scene_document_ir.py::attach_scene_semantics | jawne wait=False ma pierwszeństwo przed auto-wait |
| packages/fullmag-py/src/fullmag/live/_scene.py::build_world_scene, _PIPELINE_RUN_PAYLOAD_KEYS | usunąć analogiczne wymuszenie capture i zachować dwa klucze run |
| crates/fullmag-authoring/src/builder.rs::ScriptBuilderState | dwa optional bool, ścisły deserializer obecnej wartości |
| crates/fullmag-authoring/src/scene.rs::SceneStudyState | dwa optional bool; stage.extra już przenoszone bez strat |
| crates/fullmag-authoring/src/adapters.rs | oba adaptery top-level; zachować istniejące kopiowanie extra |
| crates/fullmag-authoring/src/validation.rs::validate_scene_document_with_mode, validate_study_pipeline_nodes | ścisła walidacja flat stages i wszystkich primitive, także w grupach |
| crates/fullmag-application/src/script_stage_materialization.rs::materialize_pipeline_primitive | zużyć wyłącznie zwalidowane dwa klucze przed parserem rodzaju i materializacją |
| crates/fullmag-api/src/types.rs, router_v2/tests.rs | uzupełnić pełne inicjalizatory buildera i regresje API |
| crates/fullmag-api/src/schemas/authoring.rs::SceneResource::from_scene_document | test zachowania istniejącej mapy study; bez nowego endpointu |
| docs/specs/execution-intent-roundtrip.md — nowy | reguły powyżej, źródła path+symbol, zgodność, ograniczenia i odbiór |

Ścieżki runtime/* w tabeli są względem packages/fullmag-py/src/fullmag/.
Pełne inicjalizatory ScriptBuilderState są także w adapters.rs::sample_builder,
fullmag-api/src/types.rs::tests::sample_builder i router_v2/tests.rs.
Inicjalizator sessions/create.rs używa Default; test ma potwierdzić pominięcie nowych pól.

## Nazwane regresje i dokładne asercje

Nazwy poniżej są nowymi testami do dodania; nie są deklaracją istniejących testów lub zaliczenia.

| Task / test | Wymagana asercja |
|---|---|
| 1: execution_intent_serde_preserves_absent_false_true | każda kombinacja 3×3 wraca identycznie przez oba adaptery; None nie serializuje klucza |
| 1: execution_intent_serde_rejects_present_non_boolean | null, "false", 0, [], {} dają Err w obu top-level typach |
| 1: stage_execution_intent_validates_flat_and_nested_payloads | niepoprawny typ daje Err także przy disabled i require_solve_refs=false |
| 2: test_script_roundtrip_preserves_stage_and_workspace_flags | skuteczne flagi workspace oraz każdej migawki przed/po są równe dla default, False, True i końcowego wait=False |
| 2: test_public_config_preserves_first_wait_and_last_interactive | oba wejścia bramek z publicznego run-config przed/po są identyczne w czterech przypadkach nowego śladu |
| 2: test_raw_multistage_flags_keep_types_in_full_and_thin_export | dla "false", 0, None wartość i type są identyczne; wait=1 pozostaje int; pełny eksport ma dwa etapy |
| 2: test_scene_flags_distinguish_missing_and_explicit_false | missing override zachowuje źródło; jawne False wyłącza flagę; typowana scena z niebooleanem odmawia |
| 2: test_live_capture_and_trim_preserve_authored_flags | live nie dodaje True; obie flagi pozostają w run payload po trim |
| 2: test_real_material_mutation_remains_rejected | źródło ze zmianą Ms=800000→600000 między etapami nadal daje ValueError |
| 2: primitive_execution_intent_applies_before_materialization | wynikowy IR run/antenna/action ma dokładnie zadane booleany, missing dziedziczy current_ir |
| 2: primitive_execution_intent_failure_restores_previous_metadata | błędny typ/nieznany klucz/rodzaj zwraca Err i odtwarza poprzednią wartość lub nieobecność obu kluczy |
| 2: disabled_primitive_does_not_change_execution_intent | poprawny, wyłączony węzeł nie zmienia bieżących flag; grupa zachowuje kolejność aktywnych dzieci |
| 3: scene_execution_intent_survives_unrelated_patch_and_export | publiczne GET/patch/persistence/export zachowują False/True oraz stage extras |
| 3: sceneMergePatchPreservesExecutionIntent | istniejący frontend resource store przechowuje pełną odpowiedź; niezwiązany patch nie wysyła replacement study |

## Task 1: Spójny kontrakt authoringu i walidacji

**Files:** builder.rs, scene.rs, adapters.rs, validation.rs z tabeli; ich istniejące moduły tests; inicjalizatory fullmag-api; nowa specyfikacja.
**Interfaces:**
- Dodać Option<bool> o dokładnych nazwach z tabeli wyłącznie do top-level ScriptBuilderState i SceneStudyState.
- Dodać w builder.rs prywatny dla crate helper deserialize_present_execution_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>, gdzie D: serde::Deserializer<'de>; obecny klucz wymaga bool. SceneStudyState używa tego samego helpera przez crate::builder. Atrybut serde(default) obsługuje wyłącznie brak.
- Oba adaptery zachowują Some(false), Some(true), None i stage.extra. Walidatory etapów odrzucają obecny nieboolean obu kluczy niezależnie od require_solve_refs.

- [x] Napisać regresje serde/adapterów dla kartezjańskiego zestawu {brak, False, True} obu flag oraz odrzuceń null/"false"/0/[]/{}.
- [x] Dodać regresje starych dokumentów, flat stage.extra, primitive w grupie oraz disabled primitive z niepoprawnym typem (walidacja nadal odmawia; wykonanie disabled niczego nie zmienia).
- [ ] Potwierdzić RED przez dozwolone CI; jeżeli GH nadal niedostępny, zachować testy jako NOT VERIFIED zamiast lokalnie kompilować testy Rust.
- [x] Wdrożyć pola, ścisły deserializer, adaptery i walidację. Nie zmieniać API mapy study ani pól fizycznych IR.
- [x] Uzupełnić specyfikację: pełna tabela parametrów, Python→IR/runtime, backend-neutralność, źródła symboli, zgodność, checklist i niewykonane bramki.
- [ ] Zweryfikować testami kontraktu i późniejszym managed buildem; przed commitem przejrzeć pełne inicjalizatory i osobno indeks. Tylko razem z częścią Python w Task 2 publikować nowy dokument z kluczami.

## Task 2: Pełny roundtrip i shared pipeline, bez zmiany bramek CLI

**Files:** wskazane Python/runtime/live, script_stage_materialization.rs, nowy packages/fullmag-py/tests/test_execution_intent_roundtrip.py; istniejące test_runtime_flags_export.py, test_live_dsl_mode.py, test_scratch_authoring_ui_roundtrip.py i test_script_builder_roundtrip.py.
**Interfaces:**
- execution_intent.py::validate_execution_intent_fields(values: Mapping[str, object], *, context: str) -> dict[str, bool]: zwraca tylko obecne klucze; exact bool, bez coercion.
- execution_intent.py::copy_execution_intent(metadata: Mapping[str, object]) -> dict[str, object]: kopiuje głęboko obecne surowe wartości obu kluczy BEZ walidacji/coercion; brak daje False wyłącznie w nowym draft/payload. Używać w export_builder_draft, _export_stage_draft_with_identity oraz _export_study_pipeline_node. Nie modyfikować wejściowego runtime_metadata.
- Dopiero adapter typowanej sceny, jej renderer oraz shared primitive execution wywołują validate_execution_intent_fields. Generic draft/pipeline jest osiągalny z LoadedProblem.to_ir również przy thin export; nie wolno tam wywołać ścisłego helpera. Renderer waliduje wynik copy_execution_intent dla migawki przed emisją skryptu.
- _render_stages zachowuje istniejącą sygnaturę; odtwarza flagi przed KAŻDYM etapem, także action z continue. render_loaded_problem_as_script przywraca finalny workspace po inventory/pipeline declarations.
- materialize_pipeline_primitive zachowuje sygnaturę. Najpierw sprawdza wszystkie obecne flagi; parserom rodzaju przekazuje payload pomniejszony wyłącznie o te dwa poprawne klucze. Stosuje flagi przed klonowaniem IR przez per-kind materializer. Brak klucza nie resetuje stanu.

- [x] Przenieść nowe testy z dowodów prywatnego wolumenu do powtarzalnego testu repo; używać execution_context, lightweight_assets i blokad Popen/gmsh.generate. Dodać wieloetapowe przypadki ze śladu public-config-stage-trace-v2.
- [x] Dodać testy stanu workspace innego niż pierwszy/ostatni etap; porównać publiczny run-config przed i po eksporcie, skuteczne flagi każdego etapu i wejścia obu bramek CLI.
- [x] Dodać testy raw metadata dla thin i pełnego export-run-config: typy i priorytet pozostają; walidacja typowanej sceny odmawia zamiast zmieniać wartość. Eksport payloadu w otwartej mapie nie może pośrednio zmienić lub normalizować surowego IR.
- [x] Dodać live capture/default/False/True oraz zachowanie run flags przez _trim_pipeline_run_payloads; wyeksportowany antenna primitive także zachowuje flagi.
- [x] Dodać testy shared compiler: run/antenna/action bez solvera, nested group, disabled node, missing key inheritance oraz invalid type/unknown kind/unknown payload key.
- [x] Odtworzyć RED. Użyć istniejącego unittest w backendzie grupy: PYTHONPATH=/opt/fullmag/source/packages/fullmag-py/src, FULLMAG_TEST_TEMP_ROOT w prywatnym control volume; python3 -B -m unittest discover -s /opt/fullmag/source/packages/fullmag-py/tests -p test_execution_intent_roundtrip.py. Nie uruchamiać hostowego buildu.
- [x] Wdrożyć cały tor Python i Rust z tabeli. Usunąć forcing także w live capture; nie używać hostowego trybu live jako deklaracji skryptu.
- [x] Dopiero z pełnym per-stage rendering usunąć interactive/wait z _stage_signature. Regresja rzeczywistej zmiany Ms/geometrii nadal musi odmawiać.
- [x] W shared materializer nie dodawać pełnego klonu ciężkiego ProblemIR tylko do dwóch flag. Przed zmianą zachować poprzednie wartości/nieobecność zmienianych kluczy, po Err je przywrócić; walidować oba typy przed pierwszym zapisem. Zachować dotychczasowe odmowy pozostałych parserów.
- [x] Uruchomić nowe i właściwe istniejące lekkie testy; Rust tests wyłącznie dozwolonym CI. Sprawdzić lint/parser i diff. Commitować spójny fragment z Task 1, jeżeli oddzielne commity nie przechodzą wszystkich granic zgodności.

## Task 3: Odbiór publicznego przepływu i integracja

**Files:** istniejące testy SceneResource w schemas/authoring.rs i router_v2/tests.rs; apps/control-room/src/kernel/resources/geometryLifecycleResources.test.ts oraz właściwe istniejące testy modeli study; dokumenty dowodów.
**Interfaces:** istniejący SceneResource.study jako mapa, obecne merge_patch i eksport projektu; bez nowych zasobów API.

- [x] Dodać API regression: scene → GET/projection → niezwiązany merge-patch → persistence → canonical export zachowuje obie flagi oraz stage extras. False musi przetrwać; null usuwa klucz zgodnie z istniejącym merge-patch.
- [x] Dodać frontend regression zachowania pełnej sceny i kształtu niezwiązanych study patches; nie dodawać kontrolek ani bezpośrednich fetch.
- [ ] Sprawdzić aktualny justfile i tożsamość grupy. Udokumentowana recepta odbioru to just docker-dev "/home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011" 3203, z zachowaniem bieżącego projektu oraz właściwych receiptów. Nie wykonać jej przed gotowym, przejrzanym kodem i zgodnym admission.
- [ ] Ponowić odczyt drain/rezerwacji. W czasie przygotowania planu rezerwacja solvera pozostaje quarantined: 3 CPU, 5637144576 B RAM. Ten plan nie upoważnia do jej zwolnienia, zmiany markerów ani obejścia bramki; odmowa oznacza jawne NOT VERIFIED dla managed odbioru.
- [ ] Po zgodnym managed buildzie wykonać kontrolę prawdziwego UI: otwarcie/eksport/ponowny import testowej sceny, bez Compute/Solve i bez modyfikacji projektu użytkownika. Potwierdzić flagi przez publiczne API i eksport, a nie tylko wygląd panelu.
- [ ] Potwierdzić brak zmiany identyfikatorów/digestów zachowanych wyników V/J/H. Nie uruchamiać solvera w celu dowodu poprawności eksportu.
- [ ] Wykonać wymagane CI, review i cykl PR zgodny z AGENTS. Nie oznaczać E12 ani reprodukcji publikacji jako ukończonej na podstawie tej poprawki.

## Kryterium odbioru

Każdy ważny kanał zachowuje wartości study, rzeczywistych etapów i końcowego workspace.
Brak klucza, False oraz True nie są utożsamiane na granicy override.
Oba obecne wejścia bramek CLI są identyczne przed/po roundtripie.
Przesłany payload nie uruchamia solvera podczas capture/export.
Niepoprawne typy i rzeczywiste mutacje fizyczne pozostają odrzucone.
Wszystkie cztery realizacje FDM/FEM CPU/GPU zachowują tę samą semantykę authoringu;
ten plan nie stanowi kwalifikacji ich solverów.

## Self-review i ograniczenia

Zakres obejmuje capture, direct export, SceneDocument, live, API projection oraz shared compiler.
Nowy schemat etapów jest zbędny: istniejące extra i primitive.payload są zachowane przez Rust adapters.
SceneResource.study już przenosi additional_properties; nie jest potrzebna regeneracja szerszego schematu.
Auto-wait nie może nadpisywać jawnego False. Nie zmieniamy fizyki ani wyboru pierwszego/ostatniego etapu w CLI.
Niezależny przegląd wykazał niejednoznaczność surowego eksportu; poprawiono ją powyżej przez oddzielny copy_execution_intent. Przejrzano pokrycie specyfikacji, kroki, sygnatury, pięć Review Focus i proporcję zakresu. Nowe ślady i przegląd są dowodem przyczyn, nie dowodem wdrożenia.
Implementacja i lekkie testy są wykonane; CI42365723712 nowego kodu zakończyło się sukcesem. Managed build i odbiór browser spójnego pakietu nadal niewykonane. Szczegóły w raporcie wykonania.

## Checkpoint 07.11.2026 — CI i rzeczywiste wejścia GSG

- Kod naprawy i fixture’ów: 5b19f00e4bf8dcc88ef8789d7c251c8e5ad5bb21,
  dec3ab642e6abe3a85459690fd908e10920858eb, 7f798b881d43dbdad1cf98ca62b40f37e3280795.
- [CI42365723712](https://github.com/MateuszZelent/fullmag/actions/runs/42365723712):
  oba wybrane joby rust-contracts i inspector-actions-browser-smoke zakończone success.
  Joby pominięte przez profil rust nie są dowodem pozostałych lane.
- Python→Python dla zachowanych rzeczywistych skryptów GSG 50 nm i projektu corner25:
  pełne IR zgodne z dotychczasową tolerancją liczb 5e-12; definicja meshu identyczna.
  Flagi zachowane również przez scenę.
- Odrębny błąd: typowana scena nie przechowuje jawnej referencji domain_mesh i markerów.
  Nie utożsamiamy go z naprawionymi flagami. Raport: 2026-11-07-gsg-scene-domain-mesh-audit.md.
- Nie wykonano meshowania, Submit/Solve, restartu lub zwolnienia quarantine.
  Corner25 pozostaje nieaktywowanym projektem.
