# Fullmag MCP — katalog narzędzi, zasobów i kontraktów

**Status:** wszystkie nazwy `fm_*` poniżej są **projektowane**. Nie są listą już zainstalowanych narzędzi.  
**Kontrakt aplikacyjny:** `fullmag.mcp.v1`; wersja MCP jest od niego niezależna.  
**Zakres:** 46 narzędzi docelowych, włączanych etapami i zależnie od uprawnień.  
**Architektura:** [02_PLAN_ARCHITEKTURY_MCP.md](02_PLAN_ARCHITEKTURY_MCP.md).

## 1. Zasady katalogu

Nazwy są stałe; opis mówi, czy narzędzie mutuje projekt, tworzy kosztowną pracę, tylko odczytuje wynik czy steruje istniejącą próbą. Nie generujemy narzędzia dla każdego endpointu. Podziały służą intencjom naukowym i bezpieczeństwu, nie odtwarzają całego drzewa HTTP.

Lista narzędzi jest stabilna dla wydania/profilu i credentials. Nie zmienia się wskutek poprzednich wywołań w rozmowie. Dynamiczne ograniczenia konkretnego modelu zwraca `fm_capabilities_get` oraz preflight. Widoczność narzędzia nie jest autoryzacją wykonania; backend sprawdza policy jeszcze raz przy każdym wywołaniu. Metadane i output schemas muszą odpowiadać faktycznie opublikowanemu profilowi. [M03]

**F1** oznacza read-only; **F2** authoring; **F3** pierwsze kontrolowane wykonanie; **F4** pełniejsze lane/data/live; **F5** kampanie. Python w F4 nadal wymaga osobnej bramki izolacji — numer fazy nie otwiera go automatycznie. F6 to kwalifikacja zdalnego wydania i rollout.

### 1.1 Klasy efektu i adnotacje

| Klasa | Efekt | Domyślna polityka |
|---|---|---|
| read | Odczyt istniejących danych / ograniczona czysta walidacja | readOnlyHint=true, idempotentHint=true |
| draft | Nowy dokument, rewizja lub asset | readOnlyHint=false; klucz idempotency dla publikacji |
| prepare | Trwały kandydat/spec, bez uruchomienia solvera | Nie jest zwykłym read; ma operation identity |
| compute | Admission kosztownej operacji | Budget/grant i durable receipt |
| control | Zmiana lifecycle pracy | Destructive hint konserwatywnie true, exact target/preconditions |
| code | Wykonanie źródła w sandboxie | Osobny scope i approval/delegation |
| access / egress | Wydanie dostępu lub eksport | ACL, byte budget i kontrola celu |
| presentation / live | Stan widoku albo attachment | Nie wpływa na fizyczny snapshot runu |

Adnotacje są wskazówką dla klienta, nie mechanizmem zabezpieczającym. `fm_model_apply` należy oznaczyć konserwatywnie jako mogące usuwać dane z draftu; nie dowodzi to, że każda jego operacja jest destrukcyjna. Narzędzia pozostają closed-world wobec sieci/hosta; ewentualny eksport do zatwierdzonego zewnętrznego targetu wymaga jawnego zakresu.

### 1.2 Stałe profile katalogu zamiast nadmiaru narzędzi w każdej rozmowie

Pełny katalog 46 narzędzi opisuje produkt docelowy, nie obowiązek wysyłania wszystkich schematów do każdego modelu. Konfiguracja instalacji może publikować profile `observer`, `authoring`, `execution`, `analysis` i `full-research`. Profil jest wybierany przy konfiguracji klienta/grantu, ma własny digest i nie przełącza się niejawnie po wywołaniu narzędzia. Każdy profil zawiera `fm_platform_get`, `fm_capabilities_get` i `fm_schema_get` oraz tylko potrzebne rodziny operacji. Scope nadal może zawęzić widoczność.

Opisy wire powinny być krótkie i rozstrzygać intencję, efekt, target i ograniczenia; rozbudowane instrukcje znajdują się w wersjonowanych resources. Schematy przekazane klientowi muszą być samowystarczalne, z lokalnymi `$defs`, o ile kwalifikacja konkretnego klienta nie dowodzi poprawnej obsługi innych referencji. Nie zakładać, że klient sam pobierze zewnętrzny `$ref`. Tokenowy koszt catalogue mierzyć osobno w I28; nie redukować go przez usuwanie niezbędnej walidacji typu.

## 2. Wspólne typy

| Typ | Treść |
|---|---|
| `ProjectLocator` | project_id; tylko do znalezienia istniejącego zasobu |
| `ProjectRef` | project_id, definition_revision jako u64-string, definition_sha256 |
| `RunLocator` | project_id, run_id; odczyt nie wymaga znajomości hasha przed discovery |
| `RunRef` | RunLocator + run_spec_sha256 |
| `AttemptRef` | RunRef + task_id, attempt_id, ownership_epoch jako u64-string |
| `ArtifactRef` | RunRef + solution_set_id, revision, member_id, artifact_id, content_sha256 |
| `MeshRef` | mesh_id, generation_id, input_definition_sha256, topology_sha256, policy_sha256 |
| `StudyRef` | study_id, plan_version, plan_sha256 i źródłowy ProjectRef |
| `ExecutionRequest` | requested backend/device/precision/mode, profile_id@version, jawne budget ceiling refs |
| `PageRequest` | cursor opcjonalny, page_size 1–500; niezależny budżet bajtowy |
| `OperationReceipt` | operation_id, status accepted/working/terminal, scope, request digest, next_read i native refs |
| `Warning` | code, severity, path, message, evidence_ref, requires_acknowledgment |
| `AgentError` | code, native_code, retriable, retry_after_ms, safe_action, details ograniczone ACL |

Trusted principal, scopes, ownership grant i endpoint konfiguracji **nie są argumentami tools/call**. Powstają z uwierzytelnionego kontekstu. W referencjach złożonych sprawdzać, czy wszystkie elementy należą do tego samego projektu/runu; poprawny format UUID nie jest wystarczający.

`definition_revision` w argumentach i `expected_revision` mutacji nie mogą sobie przeczyć. Klient przekazuje oba tylko tam, gdzie wymaga tego DTO; serwis odrzuca rozbieżność. Schematy muszą stosować u64 range validation, a nie samo wyrażenie regularne.

## 3. Katalog pełny

<a id="fm_platform_get"></a>
### N01 — `fm_platform_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** Brak parametrów poza opcjonalnym profilem odpowiedzi.  
**Wynik:** InstallationInfo: build, contract versions, policy revision, limits, readiness.

**Powiązanie z kodem:** R08/R18: platform health, runtime service i versions.

**Warunki i błędy graniczne:** Nie utożsamiać health=ok z kwalifikacją solvera; ukrywać prywatne ścieżki i adresy węzłów.

<a id="fm_capabilities_get"></a>
### N02 — `fm_capabilities_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** Opcjonalny ProjectRef i WorkloadSelector; brak selektora oznacza katalog ogólny.  
**Wynik:** CapabilityMatrix z reason_codes, restrictions i evidence_refs.

**Powiązanie z kodem:** R05/R18 + NOWE: agregacja kwalifikacji aplikacyjnej.

**Warunki i błędy graniczne:** Bez zmiany modelu i bez automatycznego wybierania CPU zamiast wymuszonego GPU.

<a id="fm_schema_get"></a>
### N03 — `fm_schema_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** Nazwa allowlisted schema i dokładna wersja.  
**Wynik:** SchemaDocument, digest i powiązane typy.

**Powiązanie z kodem:** R07/R08: OpenAPI/shared types + NOWE: bundle MCP.

**Warunki i błędy graniczne:** Brak dowolnego URL/path; nie zwracać niewersjonowanego current jako schematu historycznego runu.

<a id="fm_docs_search"></a>
### N04 — `fm_docs_search`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** Query, topics, runtime_build, page_size, cursor.  
**Wynik:** Bounded fragmenty dokumentacji z path/revision/digest/zakresem.

**Powiązanie z kodem:** NOWE: indeks zatwierdzonych docs/contracts w pakiecie runtime.

**Warunki i błędy graniczne:** Nie indeksować .env, logów prywatnych ani dowolnego filesystem; dokument jest nieufną treścią, nie grantem.

<a id="fm_projects_list"></a>
### N05 — `fm_projects_list`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** Filter i PageRequest; filtr ograniczony nazwą/id/tagami/statusami.  
**Wynik:** Page<ProjectSummary> z widocznością ACL.

**Powiązanie z kodem:** R08: trwałe zasoby projektu/workspace; NOWE: scoped catalog projection.

**Warunki i błędy graniczne:** Paginacja po stabilnym snapshot token; bez ujawniania cudzych projektów przez total_count.

<a id="fm_project_get"></a>
### N06 — `fm_project_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** ProjectLocator i opcjonalna definition_revision.  
**Wynik:** ProjectView z ProjectRef, authority_mode, study summaries i asset refs.

**Powiązanie z kodem:** R13/R15: ProjectApplication i repository.

**Warunki i błędy graniczne:** Nie otwiera projektu jako current i nie pobiera całego archiwum inline.

<a id="fm_project_create"></a>
### N07 — `fm_project_create`

**Faza:** F2. **Klasa efektu:** draft.  
**Wejście:** TemplateRef albo minimalny typed project definition, title, idempotency_key.  
**Wynik:** ProjectRef i walidowany ProjectView.

**Powiązanie z kodem:** R08/R13/R15: create project.

**Warunki i błędy graniczne:** Szablon wersjonowany; bez defaultowego Solve, startup GPU czy zmiany sesji UI.

<a id="fm_project_fork"></a>
### N08 — `fm_project_fork`

**Faza:** F2. **Klasa efektu:** draft.  
**Wejście:** Source ProjectRef, nowa nazwa, fork_policy i idempotency_key.  
**Wynik:** Nowy ProjectRef z relacją parent oraz asset references.

**Powiązanie z kodem:** R13: lifecycle; NOWE: jawny fork bez duplikacji niezmiennych CAS blobs.

**Warunki i błędy graniczne:** Nie kopiować credentials/ACL na podstawie pola modelu; uprawnienia nowego projektu wyznacza policy.

<a id="fm_project_save"></a>
### N09 — `fm_project_save`

**Faza:** F2. **Klasa efektu:** draft.  
**Wejście:** ProjectRef, registered_target_id i idempotency_key.  
**Wynik:** SaveReceipt: persisted revision, archive digest, durability i target_id.

**Powiązanie z kodem:** R13: ProjectApplication/FileProjectRepository; NOWE: registered target adapter.

**Warunki i błędy graniczne:** Nie przyjmować ścieżki hosta. Save-As/overwrite wymaga expected target generation; nie nadpisywać nowszego archiwum.

<a id="fm_project_export"></a>
### N10 — `fm_project_export`

**Faza:** F2. **Klasa efektu:** egress.  
**Wejście:** ProjectRef lub RunRef, format, include policy, idempotency_key.  
**Wynik:** OperationReceipt i później ArtifactRef bundla.

**Powiązanie z kodem:** R08/R13: eksport/repository + NOWE: reproducibility manifest.

**Warunki i błędy graniczne:** Duży ZIP nie w JSON. Dane wyników wymagają odpowiednich scope; brak .env i sekretów.

<a id="fm_asset_import"></a>
### N11 — `fm_asset_import`

**Faza:** F2. **Klasa efektu:** draft.  
**Wejście:** RegisteredUploadRef albo inline_text do 256 KiB, declared type, digest, project scope, key.  
**Wynik:** AssetRef, inspection report i provenance.

**Powiązanie z kodem:** R08: assets/import; NOWE: bezpieczny upload broker i digest validation.

**Warunki i błędy graniczne:** STL/mesh/OVF/źródło traktować jako dane. Ochrona archive traversal/bomb; nie pobierać arbitrary URL.

<a id="fm_assets_list"></a>
### N12 — `fm_assets_list`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** ProjectRef, asset kind, PageRequest.  
**Wynik:** Page<AssetSummary> z digest, bytes i validation status.

**Powiązanie z kodem:** R13/R15: project assets/CAS + NOWE: projekcja catalogue.

**Warunki i błędy graniczne:** Nie zamieniać asset name na ścieżkę i nie przypisywać prawa wykonania kodu przez rozszerzenie pliku.

<a id="fm_model_get"></a>
### N13 — `fm_model_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** ProjectRef, section selector i PageRequest dla dużych kolekcji.  
**Wynik:** ModelView/SceneDocument projection z refs i authority_mode.

**Powiązanie z kodem:** R08: scene/regions/material-fields/physics graph; NOWE: durable-document binding.

**Warunki i błędy graniczne:** Żadnego przełączenia current. Projekcja oznacza pominięte sekcje, nie usuwa ich z modelu.

<a id="fm_model_apply"></a>
### N14 — `fm_model_apply`

**Faza:** F2. **Klasa efektu:** draft.  
**Wejście:** ProjectRef, expected_revision, lista ModelOperation, idempotency_key.  
**Wynik:** Nowy ProjectRef, atomic diff, invalidated resources i warnings.

**Powiązanie z kodem:** R08: transactions i typed authoring; NOWE: headless transaction service.

**Warunki i błędy graniczne:** All-or-nothing; stosować domenowe walidatory. Niedostępne operacje odpadają przed commit.

<a id="fm_model_validate"></a>
### N15 — `fm_model_validate`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** ProjectRef, validation_level i opcjonalny workload selector.  
**Wynik:** ValidationReport z errors/warnings, units i capability restrictions.

**Powiązanie z kodem:** R08/R13: authoring/readiness/geometry validation.

**Warunki i błędy graniczne:** Nie wykonywać Python, meshingu ani solvera. Głębsza kosztowna walidacja staje się osobną operacją planowania.

<a id="fm_script_compile"></a>
### N16 — `fm_script_compile`

**Faza:** F4. **Klasa efektu:** code.  
**Wejście:** Source AssetRef, jawne import assets, compile_profile_ref, approval_ref, key.  
**Wynik:** OperationReceipt; rezultat: source/IR hashes, fidelity, diagnostics i candidate ProjectRef.

**Powiązanie z kodem:** R16 + NOWE: managed sandbox i compile-only capture.

**Warunki i błędy graniczne:** Nie wystawiać bez izolatora. Nie przekazywać boolean consent z payloadu jako autoryzacji; oryginalne źródło pozostaje zachowane.

<a id="fm_script_export"></a>
### N17 — `fm_script_export`

**Faza:** F2. **Klasa efektu:** read.  
**Wejście:** ProjectRef, format_version i output_mode.  
**Wynik:** Source preview do limitu albo immutable SourceArtifactRef; fidelity verdict.

**Powiązanie z kodem:** R04/R08: canonical script export.

**Warunki i błędy graniczne:** Dla source_authoritative eksportować zachowane źródło lub jawnie oznaczoną projekcję; brak cichego round-trip.

<a id="fm_model_diff"></a>
### N18 — `fm_model_diff`

**Faza:** F2. **Klasa efektu:** read.  
**Wejście:** Dwa ProjectRef i sekcje porównania.  
**Wynik:** SemanticDiff: znaczące zmiany fizyki, mesh/study/output i invalidations.

**Powiązanie z kodem:** NOWE: wspólna projekcja domenowa porównania SceneDocument/IR.

**Warunki i błędy graniczne:** Nie opierać równoważności fizycznej wyłącznie na różnicy tekstu JSON; nie włączać dwóch obcych projektów bez ACL.

<a id="fm_mesh_build"></a>
### N19 — `fm_mesh_build`

**Faza:** F3. **Klasa efektu:** compute.  
**Wejście:** ProjectRef, MeshPolicyRef, lane selector, budget grant, key.  
**Wynik:** OperationReceipt; rezultat MeshRef z input hash i quality summary.

**Powiązanie z kodem:** R08/R11/R12: MeshBuild, FdmGridRefresh, geometry realization.

**Warunki i błędy graniczne:** FDM nie musi mieć FEM mesh. Budowa nie aktywuje starej siatki na nowym draft; attach osobną transakcją.

<a id="fm_mesh_get"></a>
### N20 — `fm_mesh_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** MeshRef, summary/topology_metadata/build_status selector.  
**Wynik:** MeshView, generation, ownership, source refs i binary refs.

**Powiązanie z kodem:** R08: mesh build history/manifests/topology.

**Warunki i błędy graniczne:** Brak pełnych węzłów/tetraedrów inline; native payload przez kontrolowany data plane.

<a id="fm_mesh_quality"></a>
### N21 — `fm_mesh_quality`

**Faza:** F3. **Klasa efektu:** read.  
**Wejście:** MeshRef, metric set i region/object selector.  
**Wynik:** QualityReport: gates, histograms, diagnostics refs.

**Powiązanie z kodem:** R08: mesh quality/report/gates.

**Warunki i błędy graniczne:** Odczyt istniejącej oceny; nowe kosztowne obliczenie wymaga analysis job. Nie redukować wszystkich problemów do jednego średniego quality.

<a id="fm_study_get"></a>
### N22 — `fm_study_get`

**Faza:** F2. **Klasa efektu:** read.  
**Wejście:** ProjectRef i study_id.  
**Wynik:** Typed StudyView z stage graph, source bindings, outputs i stop criteria.

**Powiązanie z kodem:** R13: StudyPlan/catalog + R08: model study.

**Warunki i błędy graniczne:** Bez odczytu innej aktywnej sceny jako domyślnego wejścia.

<a id="fm_study_plan"></a>
### N23 — `fm_study_plan`

**Faza:** F2. **Klasa efektu:** read.  
**Wejście:** ProjectRef, study_id, requested execution profile i bounded preview options.  
**Wynik:** StudyPlanPreview: graph, unsupported, required preparations, cases i estimates.

**Powiązanie z kodem:** R13/R17 i istniejący planner; NOWE: agent-facing preview.

**Warunki i błędy graniczne:** Plan nie uruchamia solvera i nie rezerwuje zasobów. Compile niewykonanego źródła musi być jawne, nie ukryte.

<a id="fm_run_prepare"></a>
### N24 — `fm_run_prepare`

**Faza:** F3. **Klasa efektu:** prepare.  
**Wejście:** ProjectRef, StudyRef, ExecutionRequest, MeshRef/required assets, grant, key.  
**Wynik:** PreparedRunRef, resolved intent, estimates, warnings i approval requirements.

**Powiązanie z kodem:** R08: project run-intent; R14/R17: immutable spec/profile.

**Warunki i błędy graniczne:** Hash obejmuje pełny plan i assets. Wygaśnięcie/ref change unieważnia submit. Nie dopinać mutable defaults po akceptacji.

<a id="fm_run_submit"></a>
### N25 — `fm_run_submit`

**Faza:** F3. **Klasa efektu:** compute.  
**Wejście:** PreparedRunRef, start_policy, idempotency_key, opcjonalny approval_ref.  
**Wynik:** SubmitReceipt z RunRef, operation_id i durable acceptance disposition.

**Powiązanie z kodem:** R08/R14/R15: accepted-run store.

**Warunki i błędy graniczne:** Obowiązkowy start_policy hold/after_admission. Nie deklarować running bez native evidence; deduplikacja trwała.

<a id="fm_runs_list"></a>
### N26 — `fm_runs_list`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** ProjectLocator, lifecycle filter, PageRequest.  
**Wynik:** Page<RunSummary> z requested/resolved/executed i quality state.

**Powiązanie z kodem:** R08: projects/:id/runs.

**Warunki i błędy graniczne:** Nie wyświetlać tylko aktualnego runu jako całej historii; zachować próby i terminal reasons.

<a id="fm_run_get"></a>
### N27 — `fm_run_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** RunLocator; opcjonalna oczekiwana catalog revision dla conditional read.  
**Wynik:** RunView z native state, stages/tasks, resource usage i refs do wyników.

**Powiązanie z kodem:** R08/R15: trwały run read-model.

**Warunki i błędy graniczne:** Brak blokowania do końca symulacji. Paginować duże task graphs i logi.

<a id="fm_run_control"></a>
### N28 — `fm_run_control`

**Faza:** F3. **Klasa efektu:** control.  
**Wejście:** RunRef, action release/pause/resume/cancel, target run lub AttemptRef, expected state/catalog revision, key, reason.  
**Wynik:** ControlReceipt z command/intent identity oraz requested/acknowledged distinction.

**Powiązanie z kodem:** R11/R12/R15: commands/cancellation + NOWE: canonical release hold gate.

**Warunki i błędy graniczne:** Native safe points; nie kill(PID). Pause/resume tylko qualified; cancel nie zwalnia lease przed potwierdzeniem stopu.

<a id="fm_task_retry"></a>
### N29 — `fm_task_retry`

**Faza:** F3. **Klasa efektu:** control.  
**Wejście:** Failed AttemptRef, retry_policy_ref, expected catalog revision i key.  
**Wynik:** RetryReceipt z nową próbą i relacją do poprzedniej.

**Powiązanie z kodem:** R08/R13: task retry i RetryDecision.

**Warunki i błędy graniczne:** Nie zmieniać parametrów fizycznych ani budżetu po cichu. Retry liczy się do grantu i nie publikuje wyników starej próby jako nowych.

<a id="fm_operation_get"></a>
### N30 — `fm_operation_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** operation_id oraz scope projektu.  
**Wynik:** OperationView: accepted/working/terminal/outcome_unknown, result refs i retry hints.

**Powiązanie z kodem:** NOWE: mała projekcja durable operations nad istniejącym store/coordinatorem.

**Warunki i błędy graniczne:** Nie tworzyć drugiej kolejki. outcome_unknown wymaga reconciliation, nie automatycznego nowego submit.

<a id="fm_events_read"></a>
### N31 — `fm_events_read`

**Faza:** F3. **Klasa efektu:** read.  
**Wejście:** RunLocator albo operation scope, after_cursor i page_size.  
**Wynik:** EventPage z next_cursor, snapshot_revision, gap i resync_required.

**Powiązanie z kodem:** R07/R08: lifecycle/invalidation + NOWE: bounded durable projection.

**Warunki i błędy graniczne:** Zdarzenia nie są pełnym polem numerycznym. Po luce odczytać snapshot; brak obietnicy odtworzenia dowolnie starego streamu.

<a id="fm_checkpoint_create"></a>
### N32 — `fm_checkpoint_create`

**Faza:** F4. **Klasa efektu:** compute.  
**Wejście:** AttemptRef, requested_level, expected state revision, key.  
**Wynik:** OperationReceipt; rezultat CheckpointRef i achieved_level.

**Powiązanie z kodem:** R08/R13: checkpoint/frozen-state/native ownership.

**Warunki i błędy graniczne:** Safe point i jawny poziom physical_state/solver_restart/exact_resume; nie zawyżać poziomu z samego zapisu m.

<a id="fm_checkpoint_restore"></a>
### N33 — `fm_checkpoint_restore`

**Faza:** F4. **Klasa efektu:** prepare.  
**Wejście:** CheckpointRef, target project/profile, requested reproducibility, budget, key.  
**Wynik:** PreparedRunRef child runu z compatibility report i parent relation.

**Powiązanie z kodem:** R08: restore; NOWE: bezpieczny immutable child-run path.

**Warunki i błędy graniczne:** Nie nadpisuje aktywnego runu; odrzuca mesh/layout/ABI mismatch; wykonanie dopiero przez run_submit.

<a id="fm_results_list"></a>
### N34 — `fm_results_list`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** RunLocator, dataset/quantity filters i PageRequest.  
**Wynik:** SolutionSetCatalog z dokładnymi revisions/members/artifacts.

**Powiązanie z kodem:** R08/R15: solution sets i CAS metadata.

**Warunki i błędy graniczne:** Czytać właściwy run i current attempt metadata, nie ostatni globalny katalog.

<a id="fm_result_get"></a>
### N35 — `fm_result_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** ArtifactRef lub jawna immutable DatasetRef, metadata/summary selector.  
**Wynik:** ResultManifest z units, axes, support, dtype, quality i child refs.

**Powiązanie z kodem:** R08: dataset/solution-set/artifact read-models.

**Warunki i błędy graniczne:** Brak niejawnego generate na read; przy braku artefaktu status unavailable, nie zera.

<a id="fm_field_query"></a>
### N36 — `fm_field_query`

**Faza:** F4. **Klasa efektu:** read.  
**Wejście:** ArtifactRef, quantity/component, ROI, coordinate frame, reduction/resampling selector i output limits.  
**Wynik:** FieldQueryResult z value/ref, semantics, weighting i approximation.

**Powiązanie z kodem:** R08/R07: field/slice/scalar endpoints + NOWE: bounded scoped projection.

**Warunki i błędy graniczne:** Tylko istniejące dane i kwalifikowane redukcje. Nowa materializacja/duży koszt idzie analysis_submit; żadnej arbitralnej formuły Python.

<a id="fm_analysis_submit"></a>
### N37 — `fm_analysis_submit`

**Faza:** F4. **Klasa efektu:** compute.  
**Wejście:** Wersjonowany operator z allowlisty, input refs, typed params, budget i key.  
**Wynik:** OperationReceipt; potem AnalysisResultManifest.

**Powiązanie z kodem:** R08: analysis families; NOWE: autoryzowana orchestration operators.

**Warunki i błędy graniczne:** FMR/FFT/eigen/dispersion/topology reklamowane per capability. Manifest zapisuje normalizację, preprocessing i uncertainty/quality.

<a id="fm_artifact_access"></a>
### N38 — `fm_artifact_access`

**Faza:** F1. **Klasa efektu:** access.  
**Wejście:** ArtifactRef, intent preview/download, byte budget i key dla ticketu.  
**Wynik:** AccessReceipt: authorized data route albo krótkotrwały ticket i digest.

**Powiązanie z kodem:** R08: binary data/artifact routes; NOWE: scoped access authorization.

**Warunki i błędy graniczne:** Nie akceptuje raw path/URL. Domyślnie autoryzowane pobranie, brak publicznych linków. Zewnętrzny eksport wymaga osobnego grantu.

<a id="fm_provenance_get"></a>
### N39 — `fm_provenance_get`

**Faza:** F1. **Klasa efektu:** read.  
**Wejście:** ProjectRef lub RunRef/ArtifactRef, detail level i PageRequest.  
**Wynik:** ProvenanceGraph: source→IR→plan→profile→attempt→artifact.

**Powiązanie z kodem:** R13/R14/R15/R16/R17: istniejące hashes/manifests.

**Warunki i błędy graniczne:** Zachować requested/resolved/executed oraz warnings. Redagować credentials i prywatne ścieżki.

<a id="fm_batch_plan"></a>
### N40 — `fm_batch_plan`

**Faza:** F5. **Klasa efektu:** read.  
**Wejście:** ProjectRef, study, typed axes/join/dependencies, execution request i aggregate limits.  
**Wynik:** BatchPreview: case_count, deterministic case IDs/digests, graph i total estimate.

**Powiązanie z kodem:** R13: expand_independent_batch; NOWE: kwalifikacja sequential/adaptive classification.

**Warunki i błędy graniczne:** Nie rozwijać nieograniczonego Cartesian product w RAM; wykryć overflow przed rozwinięciem.

<a id="fm_batch_submit"></a>
### N41 — `fm_batch_submit`

**Faza:** F5. **Klasa efektu:** compute.  
**Wejście:** Przypięty BatchPlanRef, start_policy, grant/approval, key.  
**Wynik:** BatchReceipt z child RunRefs i expansion disposition.

**Powiązanie z kodem:** R08/R13: project batches i materialization.

**Warunki i błędy graniczne:** Cała kampania rozliczana sumarycznie; częściowe przyjęcie ma jawny manifest, nie ukryty success wszystkich przypadków.

<a id="fm_batch_control"></a>
### N42 — `fm_batch_control`

**Faza:** F5. **Klasa efektu:** control.  
**Wejście:** BatchRef, action pause_admission/resume_admission/cancel_pending/cancel_all, expected revision, key.  
**Wynik:** BatchControlReceipt i lista objętych case/tasks.

**Powiązanie z kodem:** R08: batch commands + istniejący coordinator.

**Warunki i błędy graniczne:** Pause admission nie oznacza pause aktywnych solverów. cancel_all wymaga jawnego zakresu i native stop evidence dla running.

<a id="fm_view_configure"></a>
### N43 — `fm_view_configure`

**Faza:** F4. **Klasa efektu:** presentation.  
**Wejście:** LiveRef lub immutable result view, expected view revision, camera/quantity/slice/selection i key.  
**Wynik:** ViewStateReceipt z requested/applied revision i ACK state.

**Powiązanie z kodem:** R08: visualization display/state/client-acks.

**Warunki i błędy graniczne:** Nie zmienia fizyki, backendu ani output policy. Nie przełącza projektu użytkownika.

<a id="fm_view_snapshot"></a>
### N44 — `fm_view_snapshot`

**Faza:** F4. **Klasa efektu:** presentation.  
**Wejście:** ViewRef, renderer browser/headless, image limits, key.  
**Wynik:** OperationReceipt lub ImageArtifactRef z render/data revisions.

**Powiązanie z kodem:** R08: visualization + NOWE: qualified snapshot service.

**Warunki i błędy graniczne:** Brak browser ACK oznacza unavailable/pending, nie zmyślony screenshot. Obraz nie zastępuje danych liczbowych.

<a id="fm_live_attach"></a>
### N45 — `fm_live_attach`

**Faza:** F4. **Klasa efektu:** live.  
**Wejście:** Jawny LiveRef, ProjectRef, requested access observe/edit i key.  
**Wynik:** LiveAttachmentRef z lease expiry, constraints i revision snapshot.

**Powiązanie z kodem:** R08/R10/R12: session clients/scope + NOWE: bounded agent lease.

**Warunki i błędy graniczne:** Nie wybiera samodzielnie current, nie tworzy nowych uprawnień i nie zabija pracy UI.

<a id="fm_live_detach"></a>
### N46 — `fm_live_detach`

**Faza:** F4. **Klasa efektu:** live.  
**Wejście:** LiveAttachmentRef i key.  
**Wynik:** DetachReceipt; zwolniony wyłącznie lease agenta.

**Powiązanie z kodem:** NOWE: cleanup attachment nad istniejącymi session clients.

**Warunki i błędy graniczne:** Nie zamyka sesji, nie usuwa projektu, nie zatrzymuje runów.


## 4. Transakcje modelu: dozwolony słownik

Każda operacja jest wariantem union `ModelOperation` z polem `kind`. Payload jest typowany istniejącym kontraktem authoringu/IR, a adapter odrzuca nieznane pola. Nie dopuszczać patchowania prywatnych ścieżek store ani `AppState`.

| Wariant projektowany | Znaczenie | Obowiązkowy warunek |
|---|---|---|
| `object.create` | Primitive albo odwołanie do geometry asset | Stabilny object_id; jednostki długości SI |
| `object.transform` | Translation/rotation/scale/pivot | Jawny układ odniesienia, kolejność transformacji i legalna skala |
| `object.remove` | Usunięcie z draftu | Wszystkie dangling references rozwiązane w tej samej transakcji |
| `geometry.replace` | Zmiana definicji geometrii istniejącego obiektu | Invalidacja realized mesh/regions/plan |
| `material.define` | Wersjonowane parametry materiału | Registry parametrów i jednostek; brak magicznych wartości domyślnych |
| `material.assign` | Materiał dla obiektu/regionu | Istniejąca referencja i jednoznaczny precedence |
| `region.create` / `region.update` | Definicja regionu i maski | Semantyka overlap i carrier zgodna z modelem |
| `region.reorder` | Zmiana kolejności stosowania regionów | Jawna lista wszystkich ID i expected membership revision |
| `region.remove` | Usunięcie regionu | Brak niejawnej zmiany numeracji używanej przez artefakty |
| `interaction.configure` | Exchange, anisotropy, DMI itd. | Warianty tylko z kanonicznego schematu i capability |
| `coupling.configure` | Międzyobiektowe/interfejsowe sprzężenie | Oba cele, jednostki, znak i geometria interfejsu |
| `field_drive.configure` | Pole Zeemana o profilu przestrzennym/czasowym | Rozdzielenie amplitudy, kierunku i profili; nie symulacja przewodnika bez osobnej capability |
| `transport.configure` / `torque.configure` | Konfiguracja wspieranego transportu/torque | Jawne źródła i wymagane przygotowanie |
| `boundary.configure` | Otwarta/PBC/Floquet/absorbing policy | Dokładny model brzegowy, nie ogólne boolean periodic |
| `initial_state.configure` | Magnetyzacja/tekstura lub checkpoint reference | Weryfikacja carrier/normalizacji/seed i źródła |
| `mesh_policy.configure` | FDM grid albo FEM mesh/airbox/interface policy | Jawny typ discretization i rodzaj demag |
| `mesh.attach` | Powiązanie ukończonej immutable siatki z draftem | Input definition/policy digest muszą nadal pasować |
| `study.configure` | Typed graph etapów | Brak cykli, brak niejawnego stanu z innego runu |
| `monitor.configure` | Obszar i próbkowanie obserwacji | Scope, quantity, cadence, output budget |
| `output.configure` | Zapis scalar/field/checkpoint | Wielkość oszacowana przed run_prepare |

Lista wariantów jest projektem API, nie deklaracją, że każdy wariant jest dziś obsługiwany przez wszystkie lane. Niekwalifikowane warianty mają być odrzucane jako capability unavailable. Dodanie wariantu wymaga aktualizacji schematu, dokumentacji i testu round-trip.

### 4.1 Przykład argumentów zmiany modelu

Poniższy fragment pokazuje strukturę **projektowanego DTO**, nie skrypt publicznego DSL ani gotowe polecenie dzisiejszego Fullmaga. Payload transformacji zostanie przypięty do istniejącej konwencji sceny w I10.

```json
{
  "project_ref": {
    "project_id": "project-demo",
    "definition_revision": "17",
    "definition_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "expected_revision": "17",
  "idempotency_key": "authoring-transform-demo-001",
  "operations": [
    {
      "kind": "object.transform",
      "object_id": "magnet-1",
      "frame": "parent",
      "translation_m": [0.000001, 0.0, 0.0],
      "rotation_representation": "quaternion_xyzw",
      "rotation": [0.0, 0.0, 0.0, 1.0],
      "scale": [1.0, 1.0, 1.0],
      "pivot_m": [0.0, 0.0, 0.0],
      "composition": "replace_local_transform"
    }
  ]
}
```

W przykładzie referencje i hashe są demonstracyjne. Transakcja z nieaktualną rewizją nie może być przyjęta nawet wtedy, gdy sama transformacja jest numerycznie legalna.

## 5. Krytyczny schemat `fm_run_submit`

To pełny przykładowy schema wejścia kontraktu v1; dokładne typy referencji mają być generowane ze wspólnych DTO, nie ręcznie powielane w serwerze. `prepared_run_id` wskazuje trwały, zwalidowany rekord. Reguły business-level (expiry, grant, equality refs, support hold) egzekwuje usługa po walidacji JSON Schema.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FullmagRunSubmitInputV1",
  "type": "object",
  "additionalProperties": false,
  "required": ["prepared_run", "start_policy", "idempotency_key"],
  "properties": {
    "prepared_run": {"$ref": "#/$defs/PreparedRunRef"},
    "start_policy": {"type": "string", "enum": ["hold", "after_admission"]},
    "idempotency_key": {"type": "string", "minLength": 16, "maxLength": 128},
    "approval_ref": {"type": "string", "minLength": 1, "maxLength": 256}
  },
  "$defs": {
    "Sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
    "U64String": {"type": "string", "pattern": "^(0|[1-9][0-9]*)$", "maxLength": 20},
    "PreparedRunRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["prepared_run_id", "project_id", "definition_revision", "definition_sha256", "plan_sha256", "profile_id", "profile_version"],
      "properties": {
        "prepared_run_id": {"type": "string", "minLength": 1, "maxLength": 256},
        "project_id": {"type": "string", "minLength": 1, "maxLength": 256},
        "definition_revision": {"$ref": "#/$defs/U64String"},
        "definition_sha256": {"$ref": "#/$defs/Sha256"},
        "plan_sha256": {"$ref": "#/$defs/Sha256"},
        "profile_id": {"type": "string", "minLength": 1, "maxLength": 256},
        "profile_version": {"type": "string", "minLength": 1, "maxLength": 128}
      }
    }
  }
}
```

Serwis sprawdza u64 ≤18446744073709551615, nawet gdy regex i maxLength przepuściły większą liczbę. `approval_ref` jest tylko referencją do zaufanej decyzji. Brak pola nie znaczy „zaakceptowano”; dozwolenie musi wynikać z ważnego grantu.

### 5.1 Zakończone wywołanie submit ≠ zakończona symulacja

Przykład **danych domenowych** przeznaczonych do structuredContent; nie jest to pełna koperta JSON-RPC, więc nie pokazuje protokołowego `_meta`.

```json
{
  "schema_version": "fullmag.mcp.v1",
  "status": "ok",
  "request_id": "req-demo-001",
  "data": {
    "operation_id": "op-demo-001",
    "disposition": "accepted",
    "durable": true,
    "run_ref": {
      "project_id": "project-demo",
      "run_id": "run-demo-001",
      "run_spec_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "lifecycle": "held",
    "execution_evidence": null,
    "quality_state": "not_assessed",
    "next_action": "fm_run_control"
  },
  "error": null,
  "warnings": []
}
```

`durable=true` wolno ustawić tylko po receipcie store. `held` wymaga natywnego gate, a nie tylko tego stringa w odpowiedzi. Przy replay klucza zwracany jest ten sam run_ref z disposition wskazującym powtórzenie; aktualny lifecycle może być już późniejszy i musi być jednoznacznie opisany jako bieżąca projekcja, a nie historyczny receipt.

## 6. Błędy i retry

Wspólna koperta posiada `status`, `data`, `error`, `warnings` i `schema_version`. Schema każdego narzędzia akceptuje wariant success i wariant domain error; przy domain error `data=null`, a `error` ma typ AgentError. Nie zwracać dowolnego tekstu łamiącego outputSchema tylko dlatego, że wystąpił błąd. Błąd transportu/protokołu pozostaje błędem MCP/HTTP, nie udawanym udanym narzędziem.

| Kod aplikacyjny projektowany | Znaczenie | Działanie agenta |
|---|---|---|
| `FM_PERMISSION_DENIED` | Brak ACL/scope/grantu | Nie ponawiać w pętli; zmiana autoryzacji poza narzędziem |
| `FM_APPROVAL_REQUIRED` | Operacja przekracza delegację | Przekazać approval request do zaufanego UI |
| `FM_SCOPE_MISMATCH` | Stara instancja/sesja/epoch | Jawny reconnect i ponowny odczyt; nie zmieniać celu automatycznie |
| `FM_REVISION_CONFLICT` | Draft zmienił się od odczytu | Diff i ponowna decyzja autora |
| `FM_IDEMPOTENCY_CONFLICT` | Klucz użyty z innym digestem | Naprawić workflow; nie maskować generując losowy nowy klucz |
| `FM_OUTCOME_UNKNOWN` | Brak potwierdzenia wyniku mutacji | Reconciliation po operation/key, nie nowy run |
| `FM_CAPABILITY_UNAVAILABLE` | Workload/lane nieobsługiwany lub niezakwalifikowany | Podać alternatywy jako nowe propozycje, nie przeplanować po cichu |
| `FM_PREFLIGHT_FAILED` | Niespójny problem/siatka/profile | Naprawa jawnego draftu i nowa rewizja |
| `FM_BUDGET_EXCEEDED` | Brak pozostałego grantu | Zmniejszyć jawny plan lub uzyskać nową delegację |
| `FM_BUSY` | Writer/admission/backpressure | Ten sam klucz, opóźnienie z jitter i wskazany retry hint |
| `FM_PREPARED_INPUT_EXPIRED` | Kandydat wygasł lub zmieniła się policy | Nowe run_prepare; nie submit starego tokenu |
| `FM_UNSUPPORTED_CONTROL` | Brak natywnego pause/resume/checkpoint | Nie emulować kill/restart bez nowego badania |
| `FM_ARTIFACT_UNAVAILABLE` | Brak zatwierdzonego/oczekiwanego wyniku | Sprawdzić run/attempt; nie zastępować zerami |
| `FM_RESULT_INTEGRITY_ERROR` | Digest/identity nie zgadza się | Zatrzymać analizę i zgłosić incydent storage |
| `FM_SCIENTIFIC_QUALITY_FAILED` | Wynik nie spełnia przypiętych kryteriów | Zachować dane i raport błędu; żadnego „success” naukowego |

Wszystkie kody zachowują `native_code`, jeżeli nie ujawnia on sekretów. Reprezentację wire narzędziowych błędów i odmów serializuje SDK zgodnie z erą; błąd naukowy nie powinien być błędem parsowania JSON-RPC. [M03]

## 7. Resources i URI

Proponowane URI są nazwami zasobów, nie ścieżkami hosta i nie tokenami dostępu:

```text
fullmag://{installation_id}/schemas/mcp/v1/{schema_name}
fullmag://{installation_id}/projects/{project_id}/revisions/{revision}/manifest
fullmag://{installation_id}/projects/{project_id}/runs/{run_id}/manifest
fullmag://{installation_id}/projects/{project_id}/runs/{run_id}/provenance
fullmag://{installation_id}/projects/{project_id}/runs/{run_id}/solutions/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/manifest
fullmag://{installation_id}/operations/{operation_id}/status
```

Manifesty wyników zawierają content_sha256 i rzeczywiste ArtifactRef. Resolver weryfikuje membership każdego elementu ścieżki. URI innej instalacji jest odrzucane, nie pobierane automatycznie przez HTTP. Publiczne schema resources mogą być cache’owane jako publiczne; dane projektu nigdy nie stają się publiczne tylko dlatego, że URI jest znane. [M10]

Serwer nie musi reklamować każdego artefaktu w jednej gigantycznej resources/list. Katalog narzędzi i stronicowane listy solution sets pozostają ścieżką discovery. Cienki klient bez obsługi resources może wykonać równoważne `fm_*_get`; nie trzeba przez to zmieniać fizyki ani dublować storage.

## 8. Mapowanie operacji na istniejące HTTP — zakres reuse

| Grupa narzędzi | Istniejąca trasa lub kontrakt | Modyfikacja potrzebna do celu |
|---|---|---|
| platform/capabilities | `/v2/platform/health`, `/capabilities`, `/runtime-service` | Policy projection i qualified evidence |
| durable projects | `/v2/persistence/projects`, `/open`, `/authoring` | Agent ACL i non-current lifecycle |
| script compile | `/v2/persistence/projects/from-script` | Nie eksponować bez sandboxu/grantu/fidelity |
| model transactions | `/v2/sessions/current/model/transactions` | Wspólna usługa nad ProjectRef, nie przełącznik current |
| meshing | `/v2/sessions/current/meshing/...` i structured commands | Immutable operation i zabezpieczenie przed stale activation |
| prepare/submit | `/v2/persistence/projects/:project_id/run-intent`, `/runs` | Durable idempotency, start_policy i grants |
| control/retry | `/simulation/commands`, `/runs/:run_id/tasks/:task_id/cancellation`, `/retry` | Jawny attempt target i native ACK |
| results | `/runs/:run_id/solution-sets/...` | Bounded read model, binary access i ACL |
| analysis | `/v2/sessions/current/analysis/...` | Scope do immutable wyników i kwalifikowany operator |
| campaigns | `/v2/persistence/projects/:project_id/batches` | Preview/budżet/stan przyjęcia częściowego |
| UI collaboration | `/visualization/state`, `/client-acks`, session clients | Agent attachment, concurrency i provenance |

Trasy są źródłowo potwierdzone w R08; kolumna modyfikacji jest projektem. Nie zakładamy, że wystarczy dodać project_id w URL do istniejącej implementacji current. Nowy upload broker jest propozycją API, nie odnalezioną trasą.

## 9. Scenariusze kontraktowe dla agenta

### 9.1 Relaksacja i impuls antenowy

Agent odczytuje capability, tworzy projekt z wersjonowanego szablonu, atomowo ustawia geometrię/materiał/oddziaływania/study i wykonuje validate. Następnie buduje discretization, odczytuje quality, przypina wynik do tej samej rewizji i planuje relax→time-domain. Run_prepare zamraża wejście i profil. Po jawnej delegacji agent wykonuje submit z wybranym start_policy. Monitoruje run_get; po ukończeniu sprawdza quality i odczytuje scalar/field artifacts, a analizę widma wykonuje wersjonowanym operatorem.

Wzbudzenie pozostaje zadanym polem, jeżeli taki model wybrano; MCP nie zamienia go w model prądu/Oersteda. Oś i units muszą być widoczne w finalnym modelu. Zmiana amplitudy po zakończeniu jest nową rewizją/runem.

### 9.2 Eigensolve, finite waveguide i thermal

Study musi podać rodzaj analizy, geometrię i BC. Agent nie interpretuje wykresu skończonego falowodu jako dyspersji Blocha bez warunków periodycznych. Manifest analizy wyraźnie określa bazę/transformację, okno obserwacji, k/f units i dostępny zakres. Dla thermal zachowuje seed policy i realizacje niezależne; nie dodaje sztucznej anteny tylko dlatego, że szablon czasowy zwykle ją ma. Unsupported zostaje zwrócone przed kosztowną pracą.

### 9.3 Błąd sieci w submit

Agent otrzymuje timeout, zapisuje operation/key i pyta o reconciliation. Serwis zwraca istniejący accepted run lub brak trwałego przyjęcia potwierdzony ledgerem. Ponowienie używa tego samego klucza i niezmiennych argumentów. Zmiana argumentów wymaga nowej świadomej operacji; nie jest naprawą transportu.

### 9.4 Dwa agenty i człowiek

Agent A i B czytają rewizję 42. A publikuje zmianę na 43. B nie może nadpisać jej z expected=42; odczytuje diff i proponuje rebase. Użytkownik przełącza current: wszystkie stare live references odrzucają mutację, ale niezależny accepted run A nadal jest dostępny po trwałym run_id. Żaden agent nie przenosi aktywnej sesji użytkownika, żeby „naprawić” błąd.

## 10. Zgodność schematów i sposób generowania

Źródłem typów domeny pozostają wspólne Rust DTO i istniejące schematy. Utoipa/OpenAPI browser contract oraz JSON Schema MCP mają różne role; generator musi jawnie przekształcać nullable/unions/number formats do przyjętego draftu i sprawdzać przykładami, zamiast kopiować OpenAPI Schema Object bez konwersji. Generator publikuje schematy jako wersjonowany bundle z digestem i aktualizuje snapshot testów.

Nowe API wykorzystywane przez UI wymaga regeneracji istniejących plików pod `apps/control-room/src/kernel/api/generated/`, nie ręcznej edycji. Stabilne protocol schemas z SDK nie są przepisywane do prywatnego forka. [R07]

Każde narzędzie wymaga testu wejścia, wyjścia, braku uprawnień, payload limit, stale scope oraz właściwego retry dla jego klasy efektu. Pokrycie nie kończy się na tym, że tools/list pokazuje nazwę.


## Odsyłacze źródłowe

[R01]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r01
[R02]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r02
[R03]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r03
[R04]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r04
[R05]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r05
[R06]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r06
[R07]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r07
[R08]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r08
[R09]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r09
[R10]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r10
[R11]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r11
[R12]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r12
[R13]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r13
[R14]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r14
[R15]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r15
[R16]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r16
[R17]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r17
[R18]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r18
[R19]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r19
[M01]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m01
[M02]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m02
[M03]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m03
[M04]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m04
[M05]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m05
[M06]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m06
[M07]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m07
[M08]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m08
[M09]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m09
[M10]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m10
